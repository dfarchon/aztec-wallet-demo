/**
 * Public View Function Optimizer
 *
 * Optimizes public static (view) function calls by bypassing the expensive
 * private execution flow (account entrypoint → witness generation → ACIR compilation).
 *
 * Instead, we:
 * 1. Create a minimal mock PrivateExecutionResult
 * 2. Call generateSimulatedProvingResult() to build kernel outputs
 * 3. Build a Tx from the kernel outputs
 * 4. Call node.simulatePublicCalls() directly
 * 5. Extract return values from the simulation
 *
 * This provides 50-80% performance improvement for public view-only calls.
 */

import {
  FunctionCall,
  FunctionType,
  type FunctionSelector,
} from "@aztec/stdlib/abi";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import {
  HashedValues,
  PrivateCallExecutionResult,
  PrivateExecutionResult,
  Tx,
  TxSimulationResult,
  type ExecutionPayload,
  BlockHeader,
  TxContext,
  NestedProcessReturnValues,
} from "@aztec/stdlib/tx";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { DecodingCache } from "../decoding/decoding-cache";
import { Fr } from "@aztec/foundation/curves/bn254";
import { makeTuple } from "@aztec/foundation/array";
import { type Tuple } from "@aztec/foundation/serialize";
import { MAX_ENQUEUED_CALLS_PER_CALL } from "@aztec/constants";
import {
  PrivateCircuitPublicInputs,
  CountedPublicCallRequest,
  PublicCallRequest,
  ClaimedLengthArray,
} from "@aztec/stdlib/kernel";
import { ChonkProof } from "@aztec/stdlib/proofs";
import { generateSimulatedProvingResult } from "@aztec/pxe/simulator";
import type { Logger } from "@aztec/aztec.js/log";
import type { GasSettings } from "@aztec/stdlib/gas";

/**
 * Detection: Check if a call is a public static (view) function.
 *
 * IMPORTANT: Only PUBLIC static functions qualify, NOT utility functions.
 * Utility functions still need the normal simulation flow.
 */
export function isPublicStaticCall(call: FunctionCall): boolean {
  return call.type === FunctionType.PUBLIC && call.isStatic === true;
}

/**
 * Extract public static calls from an execution payload.
 * Returns two arrays: eligible calls for optimization, and other calls.
 */
export function extractPublicStaticCalls(payload: ExecutionPayload): {
  publicStatic: FunctionCall[];
  other: FunctionCall[];
} {
  const publicStatic: FunctionCall[] = [];
  const other: FunctionCall[] = [];

  for (const call of payload.calls) {
    if (isPublicStaticCall(call)) {
      publicStatic.push(call);
    } else {
      other.push(call);
    }
  }

  return { publicStatic, other };
}

/**
 * Minimal ContractStore-like object for generateSimulatedProvingResult.
 * Only needs to implement getDebugFunctionName for logging purposes.
 *
 * Note: We use "as any" cast when passing to generateSimulatedProvingResult
 * since it expects a full ContractStore but only uses getDebugFunctionName.
 */
class MinimalContractStore {
  constructor(private decodingCache: DecodingCache) {}

  async getDebugFunctionName(
    address: AztecAddress,
    selector: FunctionSelector,
  ): Promise<string> {
    try {
      const instance = await this.decodingCache.getContractInstance(address);
      if (!instance) {
        return `${address.toString().slice(0, 10)}...::${selector.toString()}`;
      }

      const artifact = await this.decodingCache.getContractArtifact(
        instance.currentContractClassId,
      );
      if (!artifact) {
        return `${address.toString().slice(0, 10)}...::${selector.toString()}`;
      }

      // Find function by selector
      for (const fn of artifact.functions) {
        const { FunctionSelector: FnSelector } =
          await import("@aztec/stdlib/abi");
        const fnSelector = await FnSelector.fromNameAndParameters(
          fn.name,
          fn.parameters,
        );
        if (fnSelector.equals(selector)) {
          return `${artifact.name}::${fn.name}`;
        }
      }

      return `${artifact.name}::${selector.toString()}`;
    } catch (err) {
      // Fallback to shortened address
      return `${address.toString().slice(0, 10)}...::${selector.toString()}`;
    }
  }
}

/**
 * Public View Optimizer
 *
 * Handles optimization of public static function calls by bypassing
 * private execution and directly calling node.simulatePublicCalls.
 */
export class PublicViewOptimizer {
  private contractStore: MinimalContractStore;

  constructor(
    private node: AztecNode,
    decodingCache: DecodingCache,
    private log: Logger,
  ) {
    this.contractStore = new MinimalContractStore(decodingCache);
  }

  /**
   * Optimize a batch of public static calls (up to MAX_ENQUEUED_CALLS_PER_CALL).
   *
   * This is the core optimization: instead of going through account entrypoint
   * and private execution, we directly call node.simulatePublicCalls.
   *
   * @param publicStaticCalls - Array of public static function calls to optimize (max 32)
   * @param from - The account address making the call
   * @param chainInfo - Chain information including chainId and version
   * @param gasSettings - Gas settings for the transaction
   * @param blockHeader - Block header to use as anchor block
   * @returns TxSimulationResult with public return values
   */
  private async optimizeBatch(
    publicStaticCalls: FunctionCall[],
    from: AztecAddress,
    chainInfo: any,
    gasSettings: GasSettings,
    blockHeader: BlockHeader,
  ): Promise<{ result: TxSimulationResult; timing: number }> {
    const startTime = Date.now();
    // Step 1: Build TxContext with real values
    const txContext = new TxContext(
      chainInfo.chainId,
      chainInfo.version,
      gasSettings,
    );

    // Step 2: Encode public function calls as calldata and create PublicCallRequests
    const publicFunctionCalldata: HashedValues[] = [];

    for (const call of publicStaticCalls) {
      const calldata = await HashedValues.fromCalldata([
        call.selector.toField(),
        ...call.args,
      ]);
      publicFunctionCalldata.push(calldata);
    }

    const publicCallRequests = makeTuple(MAX_ENQUEUED_CALLS_PER_CALL, (i) => {
      const call = publicStaticCalls[i];
      if (!call) {
        return CountedPublicCallRequest.empty();
      }
      const publicCallRequest = new PublicCallRequest(
        from,
        call.to,
        call.isStatic,
        publicFunctionCalldata[i]!.hash,
      );
      // Counter starts at 1 (minRevertibleSideEffectCounter) so all calls are revertible
      return new CountedPublicCallRequest(publicCallRequest, i + 1);
    });

    // Step 3: Create PrivateCircuitPublicInputs with real values and public call requests
    // makeTuple already creates a properly typed fixed-size array
    const publicCallRequestsArray: ClaimedLengthArray<
      CountedPublicCallRequest,
      typeof MAX_ENQUEUED_CALLS_PER_CALL
    > = new ClaimedLengthArray(
      publicCallRequests as Tuple<
        CountedPublicCallRequest,
        typeof MAX_ENQUEUED_CALLS_PER_CALL
      >,
      publicStaticCalls.length, // claimed length is the actual number of calls
    );

    const publicInputs = PrivateCircuitPublicInputs.from({
      ...PrivateCircuitPublicInputs.empty(),
      anchorBlockHeader: blockHeader,
      txContext: txContext,
      publicCallRequests: publicCallRequestsArray,
      startSideEffectCounter: new Fr(0),
      endSideEffectCounter: new Fr(publicStaticCalls.length + 1), // Cover all counters from 1 to length
    });

    // Step 4: Create empty entrypoint - minimal structure with no real execution
    const emptyEntrypoint = new PrivateCallExecutionResult(
      Buffer.alloc(0), // acir: empty bytecode
      Buffer.alloc(0), // vk: empty verification key
      new Map(), // partialWitness: empty
      publicInputs, // publicInputs: with real anchorBlockHeader, txContext, and publicCallRequests
      [], // newNotes: no notes
      new Map(), // noteHashNullifierCounterMap: empty
      [], // returnValues: no private return values
      [], // offchainEffects: none
      [], // preTags: none
      [], // nestedExecutionResults: no nested calls
      [], // contractClassLogs: none
    );

    // Step 5: Create PrivateExecutionResult with just public call requests
    const privateResult = new PrivateExecutionResult(
      emptyEntrypoint,
      Fr.random(), // firstNullifier
      publicFunctionCalldata,
    );

    // Step 6: Generate simulated proving result
    // This creates the kernel outputs as if private execution occurred
    // Note: Cast to any since ContractStore expects a full class instance
    // but generateSimulatedProvingResult only uses getDebugFunctionName
    const provingResult = await generateSimulatedProvingResult(
      privateResult,
      this.contractStore as any,
      1, // minRevertibleSideEffectCounter - all our calls have counter >= 1
    );

    // Step 7: Build Tx from kernel outputs
    const tx = await Tx.create({
      data: provingResult.publicInputs,
      chonkProof: ChonkProof.empty(),
      contractClassLogFields: [],
      publicFunctionCalldata: publicFunctionCalldata,
    });

    // Step 8: Simulate public calls on the node with fee enforcement disabled
    const publicOutput = await this.node.simulatePublicCalls(
      tx,
      true /* skipFeeEnforcement */,
    );

    const timing = Date.now() - startTime;

    // Step 9: Return TxSimulationResult with timing
    return {
      result: new TxSimulationResult(
        privateResult,
        provingResult.publicInputs,
        publicOutput,
        undefined, // stats will be populated by caller
      ),
      timing,
    };
  }

  /**
   * Optimize public static calls by batching into groups of MAX_ENQUEUED_CALLS_PER_CALL.
   *
   * @param publicStaticCalls - Array of public static function calls to optimize
   * @param from - The account address making the call
   * @param chainInfo - Chain information including chainId and version
   * @param gasSettings - Gas settings for the transaction
   * @param blockHeader - Block header to use as anchor block
   * @returns Array of TxSimulationResult (one per batch)
   */
  async optimizePublicStaticCalls(
    publicStaticCalls: FunctionCall[],
    from: AztecAddress,
    chainInfo: any,
    gasSettings: GasSettings,
    blockHeader: BlockHeader,
  ): Promise<TxSimulationResult[]> {
    const batches: FunctionCall[][] = [];

    // Split into batches of MAX_ENQUEUED_CALLS_PER_CALL
    for (
      let i = 0;
      i < publicStaticCalls.length;
      i += MAX_ENQUEUED_CALLS_PER_CALL
    ) {
      batches.push(publicStaticCalls.slice(i, i + MAX_ENQUEUED_CALLS_PER_CALL));
    }

    this.log.debug(
      `Optimizing ${publicStaticCalls.length} public static calls in ${batches.length} batch(es)`,
    );

    const results: TxSimulationResult[] = [];
    let totalTiming = 0;

    for (const batch of batches) {
      const { result, timing } = await this.optimizeBatch(
        batch,
        from,
        chainInfo,
        gasSettings,
        blockHeader,
      );
      results.push(result);
      totalTiming += timing;
    }

    this.log.debug(`Optimization complete in ${totalTiming}ms`);

    return results;
  }
}
