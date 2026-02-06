import {
  ExternalOperation,
  type PrepareResult,
  type PersistenceConfig,
} from "./base-operation";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";
import {
  TxSimulationResult,
  NestedProcessReturnValues,
  type TxExecutionRequest,
  type SimulationStats,
  type ExecutionPayload,
  type PublicSimulationOutput,
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
import type { ContractArtifact, FunctionCall } from "@aztec/stdlib/abi";
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

/** Result of merging return values from optimized and normal simulation paths */
interface MergedReturnValues {
  /** Return values in original call order */
  ordered: NestedProcessReturnValues[];
  /** Return values for optimized calls only, in their relative order */
  optimized: NestedProcessReturnValues[];
}

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
};

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

    // STEP 1: Separate calls into optimized (public static) and normal paths
    const { publicStatic, other } = extractPublicStaticCalls(executionPayload);
    const callOrder = executionPayload.calls.map((call) =>
      isPublicStaticCall(call),
    );

    const chainInfo = await this.getChainInfo();
    const blockHeader = await this.pxe.debug.getSyncedBlockHeader();

    // STEP 2: Run both paths in parallel
    const [optimizedResults, normalResult] = await Promise.all([
      publicStatic.length > 0
        ? this.optimizer.optimizePublicStaticCalls(
            publicStatic,
            opts.from,
            chainInfo,
            feeOptions.gasSettings,
            blockHeader,
          )
        : Promise.resolve([]),

      other.length > 0
        ? this.runNormalSimulation(
            executionPayload,
            other,
            feeExecutionPayload,
            feeOptions.gasSettings,
            chainInfo,
            executionOptions,
            opts.from,
          )
        : Promise.resolve(null),
    ]);

    // STEP 3: Extract and merge return values from both paths
    const mergedReturnValues = this.mergeReturnValues(
      optimizedResults,
      normalResult?.result ?? null,
      callOrder,
      publicStatic.length,
      other.length,
    );

    // STEP 4: Build the final merged TxSimulationResult
    const simulationResult = this.buildMergedSimulationResult(
      optimizedResults,
      normalResult?.result ?? null,
      mergedReturnValues.ordered,
    );

    await this.db.storeTxSimulation(payloadHash, simulationResult, {
      from: opts.from.toString(),
      embeddedPaymentMethodFeePayer: executionPayload.feePayer?.toString(),
    });

    // STEP 5: Decode the transaction (including optimized public calls if any)
    const decodingService = new TxDecodingService(this.decodingCache, this.log);
    const decoded = await decodingService.decodeTransaction(simulationResult);

    // Create one storage key per function call for 1:1 mapping with capabilities
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

  /**
   * Run the normal (non-optimized) simulation path for private/non-static calls.
   */
  private async runNormalSimulation(
    originalPayload: ExecutionPayload,
    calls: FunctionCall[],
    feeExecutionPayload: ExecutionPayload | undefined,
    gasSettings: GasSettings,
    chainInfo: ChainInfo,
    executionOptions: DefaultAccountEntrypointOptions,
    from: AztecAddress,
  ): Promise<{ result: TxSimulationResult; txReq: TxExecutionRequest }> {
    const normalPayload = feeExecutionPayload
      ? mergeExecutionPayloads([
          feeExecutionPayload,
          { ...originalPayload, calls },
        ])
      : { ...originalPayload, calls };

    const { account, instance, artifact } =
      await this.getFakeAccountDataFor(from);

    const txReq = await account.createTxExecutionRequest(
      normalPayload,
      gasSettings,
      chainInfo,
      executionOptions,
    );

    const result = await this.pxe.simulateTx(txReq, true, true, true, {
      contracts: { [from.toString()]: { instance, artifact } },
    });

    return { result, txReq };
  }

  /**
   * Merge return values from optimized and normal simulation paths.
   *
   * @param optimizedResults - Results from the optimizer (one per batch)
   * @param normalResult - Result from normal PXE simulation (null if no normal calls)
   * @param callOrder - Boolean array indicating which calls were optimized (true) vs normal (false)
   * @param expectedOptimizedCount - Number of optimized calls expected
   * @param expectedNormalCount - Number of normal calls expected
   * @returns Merged return values in original order and optimized-only subset
   */
  private mergeReturnValues(
    optimizedResults: TxSimulationResult[],
    normalResult: TxSimulationResult | null,
    callOrder: boolean[],
    expectedOptimizedCount: number,
    expectedNormalCount: number,
  ): MergedReturnValues {
    // Extract return values from optimizer batches (flatten in order)
    const optimizedReturnValues: NestedProcessReturnValues[] = [];
    for (const batchResult of optimizedResults) {
      const batchValues = batchResult.publicOutput?.publicReturnValues ?? [];
      optimizedReturnValues.push(...batchValues);
    }

    // Extract return values from normal simulation
    const normalReturnValues =
      normalResult?.publicOutput?.publicReturnValues ?? [];

    // Validate counts match expectations
    if (optimizedReturnValues.length !== expectedOptimizedCount) {
      this.log.warn(
        `Optimizer returned ${optimizedReturnValues.length} return values, expected ${expectedOptimizedCount}`,
      );
    }
    if (normalReturnValues.length !== expectedNormalCount) {
      this.log.warn(
        `Normal simulation returned ${normalReturnValues.length} return values, expected ${expectedNormalCount}`,
      );
    }

    // Reconstruct return values in original call order
    const orderedReturnValues: NestedProcessReturnValues[] = [];
    let optIdx = 0;
    let normIdx = 0;

    for (const isOptimized of callOrder) {
      if (isOptimized) {
        orderedReturnValues.push(
          optimizedReturnValues[optIdx++] ?? new NestedProcessReturnValues([]),
        );
      } else {
        orderedReturnValues.push(
          normalReturnValues[normIdx++] ?? new NestedProcessReturnValues([]),
        );
      }
    }

    return {
      ordered: orderedReturnValues,
      optimized: optimizedReturnValues,
    };
  }

  /**
   * Build the final merged TxSimulationResult from both paths.
   *
   * @param optimizedResults - Results from optimizer batches
   * @param normalResult - Result from normal simulation (null if all calls were optimized)
   * @param orderedReturnValues - Return values merged in original call order
   * @returns A single TxSimulationResult combining both paths
   */
  private buildMergedSimulationResult(
    optimizedResults: TxSimulationResult[],
    normalResult: TxSimulationResult | null,
    orderedReturnValues: NestedProcessReturnValues[],
  ): TxSimulationResult {
    // Use normal result as base if available (has richer private execution data)
    const baseResult = normalResult ?? optimizedResults[0];

    // Build merged public output with ordered return values
    const mergedPublicOutput: PublicSimulationOutput | undefined =
      baseResult.publicOutput
        ? {
            ...baseResult.publicOutput,
            publicReturnValues: orderedReturnValues,
          }
        : undefined;

    return new TxSimulationResult(
      baseResult.privateExecutionResult,
      baseResult.publicInputs,
      mergedPublicOutput,
      normalResult?.stats, // Stats only available from normal simulation
    );
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
