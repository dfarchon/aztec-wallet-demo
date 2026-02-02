import {
  ExternalOperation,
  type PrepareResult,
  type PersistenceConfig,
} from "./base-operation";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";
import {
  TxSimulationResult,
  type TxExecutionRequest,
  type SimulationStats,
  type ExecutionPayload,
  mergeExecutionPayloads,
} from "@aztec/stdlib/tx";
import type { PXE } from "@aztec/pxe/server";
import { Fr } from "@aztec/foundation/curves/bn254";
import {
  WalletInteraction,
  type WalletInteractionType,
} from "../types/wallet-interaction";
import type { WalletDB } from "../database/wallet-db";
import type { InteractionManager } from "../managers/interaction-manager";
import type { AuthorizationManager } from "../managers/authorization-manager";
import type { DecodingCache } from "../decoding/decoding-cache";
import type { DefaultAccountEntrypointOptions } from "@aztec/entrypoints/account";
import { TxDecodingService } from "../decoding/tx-decoding-service";
import type { ReadableCallAuthorization } from "../decoding/call-authorization-formatter";
import type { DecodedExecutionTrace } from "../decoding/tx-callstack-decoder";
import {
  hashExecutionPayload,
  generateSimulationTitle,
} from "../utils/simulation-utils";
import type { SimulateOptions } from "@aztec/aztec.js/wallet";
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract";
import type { ContractArtifact } from "@aztec/stdlib/abi";
import type { GasSettings } from "@aztec/stdlib/gas";
import type { FieldsOf } from "@aztec/foundation/types";
import type { FeeOptions } from "@aztec/wallet-sdk/base-wallet";
import type { ChainInfo } from "@aztec/entrypoints/interfaces";
import type { AztecNode } from "@aztec/aztec.js/node";
import {
  PublicViewOptimizer,
  extractPublicStaticCalls,
  isPublicStaticCall,
} from "../utils/public-view-optimizer";
import type { Logger } from "@aztec/aztec.js/log";

// Readable transaction information with decoded data
interface ReadableTxInformation {
  callAuthorizations: ReadableCallAuthorization[];
  executionTrace: DecodedExecutionTrace;
}

// Fake account data structure
interface FakeAccountData {
  account: {
    createTxExecutionRequest: (
      payload: ExecutionPayload,
      gasSettings: unknown,
      chainInfo: ChainInfo,
      options: DefaultAccountEntrypointOptions,
    ) => Promise<TxExecutionRequest>;
  };
  instance: ContractInstanceWithAddress;
  artifact: ContractArtifact;
}

// Arguments tuple for the operation
type SimulateTxArgs = [
  executionPayload: ExecutionPayload,
  opts: SimulateOptions,
  existingInteraction?: WalletInteraction<WalletInteractionType>,
];

// Result type for the operation
type SimulateTxResult = TxSimulationResult;

// Execution data stored between prepare and execute phases
interface SimulateTxExecutionData {
  simulationResult: TxSimulationResult;
  payloadHash: string;
  decoded?: ReadableTxInformation;
}

// Display data for authorization UI
type SimulateTxDisplayData = {
  payloadHash: string;
  title: string;
  from: AztecAddress;
  decoded: ReadableTxInformation;
  stats?: SimulationStats;
  embeddedPaymentMethodFeePayer?: string;
} & Record<string, unknown>;

/**
 * SimulateTx operation implementation.
 *
 * Handles transaction simulation with the following features:
 * - Fee options processing (gas estimation, payment methods)
 * - Fake account creation for simulation
 * - Transaction execution request creation
 * - Transaction decoding with call authorizations and execution traces
 * - Persistent authorization based on payload hash
 * - Storage of simulation results
 * - Support for existing interactions (e.g., from sendTx flow)
 */
export class SimulateTxOperation extends ExternalOperation<
  SimulateTxArgs,
  SimulateTxResult,
  SimulateTxExecutionData,
  SimulateTxDisplayData
> {
  protected interactionManager: InteractionManager;
  private optimizer: PublicViewOptimizer;

  constructor(
    private pxe: PXE,
    private node: AztecNode,
    private db: WalletDB,
    private decodingCache: DecodingCache,
    interactionManager: InteractionManager,
    private authorizationManager: AuthorizationManager,
    private completeFeeOptionsForEstimation: (
      from: AztecAddress,
      feePayer: AztecAddress | undefined,
      gasSettings?: Partial<FieldsOf<GasSettings>>,
    ) => Promise<FeeOptions>,
    private completeFeeOptions: (
      from: AztecAddress,
      feePayer: AztecAddress | undefined,
      gasSettings?: Partial<FieldsOf<GasSettings>>,
    ) => Promise<FeeOptions>,
    private getFakeAccountDataFor: (
      address: AztecAddress,
    ) => Promise<FakeAccountData>,
    private getChainInfo: () => Promise<ChainInfo>,
    private cancellableTransactions: boolean,
    private log: Logger,
  ) {
    super();
    this.interactionManager = interactionManager;
    this.optimizer = new PublicViewOptimizer(node, decodingCache, log);
  }

  async check(
    _executionPayload: ExecutionPayload,
    _opts: SimulateOptions,
  ): Promise<SimulateTxResult | undefined> {
    // No early return checks for this operation
    return undefined;
  }

  async prepare(
    executionPayload: ExecutionPayload,
    opts: SimulateOptions,
  ): Promise<
    PrepareResult<
      SimulateTxResult,
      SimulateTxDisplayData,
      SimulateTxExecutionData
    >
  > {
    // Generate payload hash and detailed title
    const payloadHash = hashExecutionPayload(executionPayload);
    const title = await generateSimulationTitle(
      executionPayload,
      this.decodingCache,
      opts.from,
      executionPayload.feePayer,
    );

    // Process fee options
    const feeOptions = opts.fee?.estimateGas
      ? await this.completeFeeOptionsForEstimation(
          opts.from,
          executionPayload.feePayer,
          opts.fee?.gasSettings,
        )
      : await this.completeFeeOptions(
          opts.from,
          executionPayload.feePayer,
          opts.fee?.gasSettings,
        );

    const feeExecutionPayload =
      await feeOptions.walletFeePaymentMethod?.getExecutionPayload();
    const executionOptions: DefaultAccountEntrypointOptions = {
      txNonce: Fr.random(),
      cancellable: this.cancellableTransactions,
      feePaymentMethodOptions: feeOptions.accountFeePaymentMethodOptions,
    };

    // STEP 1: Extract and track original order
    const { publicStatic, other } = extractPublicStaticCalls(executionPayload);
    const callOrder = executionPayload.calls.map((call) =>
      isPublicStaticCall(call),
    );

    const chainInfo = await this.getChainInfo();
    const blockHeader = await this.pxe.debug.getSyncedBlockHeader();

    // STEP 2: Always run both paths in parallel (empty if no calls)
    const optimizationStartTime = publicStatic.length > 0 ? Date.now() : 0;

    const [optimizedResults, normalResult] = await Promise.all([
      // Optimization path (returns empty array if no public static calls)
      publicStatic.length > 0
        ? this.optimizer.optimizePublicStaticCalls(
            publicStatic,
            opts.from,
            chainInfo,
            feeOptions.gasSettings,
            blockHeader,
          )
        : Promise.resolve([] as TxSimulationResult[]),

      // Normal simulation path (returns null if no other calls)
      other.length > 0
        ? (async () => {
            const normalPayload = feeExecutionPayload
              ? mergeExecutionPayloads([
                  feeExecutionPayload,
                  { ...executionPayload, calls: other },
                ])
              : { ...executionPayload, calls: other };

            const { account, instance, artifact } =
              await this.getFakeAccountDataFor(opts.from);

            const txReq = await account.createTxExecutionRequest(
              normalPayload,
              feeOptions.gasSettings,
              chainInfo,
              executionOptions,
            );

            const result = await this.pxe.simulateTx(txReq, true, true, true, {
              contracts: { [opts.from.toString()]: { instance, artifact } },
            });

            return { result, txReq };
          })()
        : Promise.resolve(null),
    ]);

    // STEP 3: Merge results respecting original order
    const optimizedReturnValues = optimizedResults
      .flatMap((r) => r.publicOutput?.publicReturnValues || [])
      .filter((rv) => rv !== undefined);
    const normalReturnValues =
      normalResult?.result.publicOutput?.publicReturnValues || [];

    // Reconstruct return values in original call order
    const orderedReturnValues = [];
    let optimizedIdx = 0;
    let normalIdx = 0;

    for (const isOptimized of callOrder) {
      if (isOptimized) {
        orderedReturnValues.push(optimizedReturnValues[optimizedIdx++]);
      } else {
        orderedReturnValues.push(normalReturnValues[normalIdx++]);
      }
    }

    // Build final result
    let simulationResult: TxSimulationResult;

    if (normalResult) {
      // Mixed case: use normal result as base (private execution dominates timing)
      simulationResult = new TxSimulationResult(
        normalResult.result.privateExecutionResult,
        normalResult.result.publicInputs,
        normalResult.result.publicOutput
          ? {
              ...normalResult.result.publicOutput,
              publicReturnValues: orderedReturnValues,
            }
          : undefined,
        normalResult.result.stats,
      );
    } else {
      // Pure optimization - all calls were public static
      const base = optimizedResults[0];
      const optimizationTiming = Date.now() - optimizationStartTime;

      // Flatten all return values from all batches
      const allReturnValues = optimizedResults
        .flatMap((r) => r.publicOutput?.publicReturnValues || [])
        .filter((rv) => rv !== undefined);

      simulationResult = new TxSimulationResult(
        base.privateExecutionResult,
        base.publicInputs,
        optimizedResults.length === 1
          ? base.publicOutput
          : {
              ...base.publicOutput!,
              publicReturnValues: allReturnValues,
            },
      );

      // Update return values to match original order (already correct in this case)
      if (simulationResult.publicOutput) {
        simulationResult.publicOutput.publicReturnValues = orderedReturnValues;
      }
    }

    await this.db.storeTxSimulation(payloadHash, simulationResult, {
      from: opts.from.toString(),
      embeddedPaymentMethodFeePayer: executionPayload.feePayer?.toString(),
    });

    const decodingService = new TxDecodingService(this.decodingCache, this.log);
    const decoded = await decodingService.decodeTransaction(simulationResult);

    // Create one storage key per function call for 1:1 mapping with capabilities
    // Pattern: simulateTx:${contractAddress}:${functionName}
    const storageKeys =
      executionPayload.calls?.map(
        (call) => `simulateTx:${call.to.toString()}:${call.name}`,
      ) || [];

    return {
      displayData: {
        payloadHash,
        title,
        from: opts.from,
        decoded,
        stats: simulationResult.stats,
        embeddedPaymentMethodFeePayer: executionPayload.feePayer?.toString(),
      },
      executionData: {
        simulationResult,
        payloadHash,
        decoded,
      },
      persistence: {
        storageKey: storageKeys,
        persistData: null,
      },
    };
  }

  async createInteraction(
    executionPayload: ExecutionPayload,
    opts: SimulateOptions,
  ): Promise<WalletInteraction<WalletInteractionType>> {
    // Create interaction with simple title from args only
    const payloadHash = hashExecutionPayload(executionPayload);
    const title = await generateSimulationTitle(
      executionPayload,
      this.decodingCache,
      opts.from,
      executionPayload.feePayer,
    );
    const interaction = WalletInteraction.from({
      id: payloadHash,
      type: "simulateTx",
      title,
      description: `From: ${opts.from.toString()}`,
      complete: false,
      status: "SIMULATING",
      timestamp: Date.now(),
    });

    await this.interactionManager.storeAndEmit(interaction);

    return interaction;
  }

  async requestAuthorization(
    displayData: SimulateTxDisplayData,
    persistence?: PersistenceConfig,
  ): Promise<void> {
    // Update interaction with detailed title and status
    await this.emitProgress("REQUESTING AUTHORIZATION", undefined, false, {
      title: displayData.title,
    });

    // Request authorization with optional persistent caching
    await this.authorizationManager.requestAuthorization([
      {
        id: crypto.randomUUID(),
        appId: this.authorizationManager.appId,
        method: "simulateTx",
        params: {
          payloadHash: displayData.payloadHash,
          callAuthorizations: displayData.decoded.callAuthorizations,
          executionTrace: displayData.decoded.executionTrace,
          title: displayData.title,
          from: displayData.from.toString(),
          stats: displayData.stats,
          embeddedPaymentMethodFeePayer:
            displayData.embeddedPaymentMethodFeePayer,
        },
        timestamp: Date.now(),
        persistence,
      },
    ]);
  }

  async execute(
    executionData: SimulateTxExecutionData,
  ): Promise<SimulateTxResult> {
    await this.emitProgress("SUCCESS", undefined, true);
    return executionData.simulationResult;
  }
}
