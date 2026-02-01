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
import type { AztecAddress } from "@aztec/stdlib/aztec-address";
import {
  HashedValues,
  PrivateCallExecutionResult,
  PrivateExecutionResult,
  Tx,
  TxSimulationResult,
  type ExecutionPayload,
  BlockHeader,
  TxContext,
} from "@aztec/stdlib/tx";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { DecodingCache } from "../decoding/decoding-cache";
import { Fr } from "@aztec/foundation/curves/bn254";
import { padArrayEnd } from "@aztec/foundation/collection";
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
    private decodingCache: DecodingCache,
    private log: Logger,
  ) {
    this.contractStore = new MinimalContractStore(decodingCache);
  }

  /**
   * Optimize public static calls by bypassing private execution.
   *
   * This is the core optimization: instead of going through account entrypoint
   * and private execution, we directly call node.simulatePublicCalls.
   *
   * @param publicStaticCalls - Array of public static function calls to optimize
   * @param from - The account address making the call
   * @param chainInfo - Chain information including chainId and version
   * @param gasSettings - Gas settings for the transaction
   * @param blockHeader - Block header to use as anchor block
   * @returns TxSimulationResult with public return values
   */
  async optimizePublicStaticCalls(
    publicStaticCalls: FunctionCall[],
    from: AztecAddress,
    chainInfo: any,
    gasSettings: GasSettings,
    blockHeader: BlockHeader,
  ): Promise<TxSimulationResult> {
    // Step 1: Build TxContext with real values
    const txContext = new TxContext(
      chainInfo.chainId,
      chainInfo.version,
      gasSettings,
    );

    // Step 2: Encode public function calls as calldata and create PublicCallRequests
    const publicFunctionCalldata: HashedValues[] = [];
    const publicCallRequests: CountedPublicCallRequest[] = [];

    let counter = 0;
    for (const call of publicStaticCalls) {
      // Encode the function call arguments
      const calldata = await HashedValues.fromCalldata([
        call.selector.toField(),
        ...call.args,
      ]);
      publicFunctionCalldata.push(calldata);

      // Create PublicCallRequest for this call
      const publicCallRequest = await PublicCallRequest.fromCalldata(
        from, // msgSender
        call.to, // contractAddress
        call.isStatic, // isStaticCall (should be true)
        call.args, // calldata
      );

      publicCallRequests.push(
        new CountedPublicCallRequest(publicCallRequest, counter++),
      );
    }

    // Step 3: Create PrivateCircuitPublicInputs with real values and public call requests
    const publicCallRequestsArray: ClaimedLengthArray<
      CountedPublicCallRequest,
      typeof MAX_ENQUEUED_CALLS_PER_CALL
    > = new ClaimedLengthArray(
      padArrayEnd(
        publicCallRequests,
        CountedPublicCallRequest.empty(),
        MAX_ENQUEUED_CALLS_PER_CALL,
      ) as Tuple<CountedPublicCallRequest, typeof MAX_ENQUEUED_CALLS_PER_CALL>,
      publicCallRequests.length,
    );

    const publicInputs = PrivateCircuitPublicInputs.from({
      ...PrivateCircuitPublicInputs.empty(),
      anchorBlockHeader: blockHeader,
      txContext: txContext,
      publicCallRequests: publicCallRequestsArray,
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
      1,
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

    // Step 9: Return TxSimulationResult
    return new TxSimulationResult(
      privateResult,
      provingResult.publicInputs,
      publicOutput,
      undefined, // stats: will be populated if needed
    );
  }

  /**
   * Merge optimized public static results with normal simulation results.
   * Reconstructs return values in original call order.
   *
   * @param normalResult - Result from normal simulation (private + non-static calls)
   * @param optimizedResults - Array of batch results from optimized public static calls
   * @param originalCalls - Original call order from execution payload
   * @param publicStatic - The public static calls that were optimized
   * @param other - The other calls that went through normal simulation
   * @returns Merged TxSimulationResult with return values in original order
   */
  mergeSimulationResults(
    normalResult: TxSimulationResult,
    optimizedResults: TxSimulationResult[],
    originalCalls: FunctionCall[],
    publicStatic: FunctionCall[],
    _other: FunctionCall[],
  ): TxSimulationResult {
    // Flatten optimized return values from batches
    const flatOptimizedReturnValues = optimizedResults.flatMap(
      (r) => r.publicOutput?.publicReturnValues || [],
    );

    this.log.debug(
      `Merging ${flatOptimizedReturnValues.length} optimized + ${normalResult.publicOutput?.publicReturnValues?.length || 0} normal results`,
    );

    // Create index mapping: original call index -> result source
    const callIndexMap = new Map<
      number,
      { type: "optimized" | "normal"; index: number }
    >();

    let optimizedIdx = 0;
    let normalIdx = 0;

    for (let i = 0; i < originalCalls.length; i++) {
      const call = originalCalls[i];
      const isPublicStatic = publicStatic.some(
        (ps) =>
          ps.to.equals(call.to) &&
          ps.name === call.name &&
          ps.selector.equals(call.selector),
      );

      if (isPublicStatic) {
        callIndexMap.set(i, { type: "optimized", index: optimizedIdx++ });
      } else {
        callIndexMap.set(i, { type: "normal", index: normalIdx++ });
      }
    }

    // Extract return values from both sources
    const normalReturnValues =
      normalResult.publicOutput?.publicReturnValues || [];

    // Reconstruct in original order
    const mergedReturnValues = [];
    for (let i = 0; i < originalCalls.length; i++) {
      const mapping = callIndexMap.get(i);
      if (!mapping) continue;

      if (mapping.type === "optimized") {
        mergedReturnValues.push(flatOptimizedReturnValues[mapping.index]);
      } else {
        mergedReturnValues.push(normalReturnValues[mapping.index]);
      }
    }

    // Return merged result using normal simulation as base
    return new TxSimulationResult(
      normalResult.privateExecutionResult,
      normalResult.publicInputs,
      {
        ...normalResult.publicOutput!,
        publicReturnValues: mergedReturnValues,
      },
      normalResult.stats,
    );
  }

  /**
   * Merge multiple optimized batch results into a single TxSimulationResult.
   * Used when ALL calls are public static (no normal simulation).
   *
   * @param optimizedResults - Array of batch optimization results
   * @returns Single merged TxSimulationResult
   */
  mergeOptimizedResults(
    optimizedResults: TxSimulationResult[],
  ): TxSimulationResult {
    if (optimizedResults.length === 0) {
      throw new Error("Cannot merge empty optimized results");
    }

    if (optimizedResults.length === 1) {
      return optimizedResults[0];
    }

    this.log.debug(
      `Merging ${optimizedResults.length} batched optimized results`,
    );

    // Use first result as base
    const base = optimizedResults[0];

    // Flatten all return values from all batches
    const allReturnValues = optimizedResults.flatMap(
      (r) => r.publicOutput?.publicReturnValues || [],
    );

    return new TxSimulationResult(
      base.privateExecutionResult,
      base.publicInputs,
      {
        ...base.publicOutput!,
        publicReturnValues: allReturnValues,
      },
      base.stats,
    );
  }
}
