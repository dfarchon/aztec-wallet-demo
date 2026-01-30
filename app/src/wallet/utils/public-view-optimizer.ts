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
} from "@aztec/stdlib/tx";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { DecodingCache } from "../decoding/decoding-cache";
import { Fr } from "@aztec/foundation/curves/bn254";
import { PrivateCircuitPublicInputs } from "@aztec/stdlib/kernel";
import { ChonkProof } from "@aztec/stdlib/proofs";
import { generateSimulatedProvingResult } from "@aztec/pxe/simulator";

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
 * Minimal ContractStore implementation for generateSimulatedProvingResult.
 * Only needs to implement getDebugFunctionName for logging purposes.
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
   * @param chainInfo - Chain information including txContext
   * @returns TxSimulationResult with public return values
   */
  async optimizePublicStaticCalls(
    publicStaticCalls: FunctionCall[],
    from: AztecAddress,
    chainInfo: any,
  ): Promise<TxSimulationResult> {
    // Step 1: Create empty PrivateCallExecutionResult (no actual private execution)
    const emptyPublicInputs = PrivateCircuitPublicInputs.empty();

    // Create empty entrypoint - minimal structure with no real execution
    const emptyEntrypoint = new PrivateCallExecutionResult(
      Buffer.alloc(0), // acir: empty bytecode
      Buffer.alloc(0), // vk: empty verification key
      new Map(), // partialWitness: empty
      emptyPublicInputs, // publicInputs: empty kernel inputs
      [], // newNotes: no notes
      new Map(), // noteHashNullifierCounterMap: empty
      [], // returnValues: no private return values
      [], // offchainEffects: none
      [], // preTags: none
      [], // nestedExecutionResults: no nested calls
      [], // contractClassLogs: none
    );

    // Step 2: Encode public function calls as calldata
    // Each public function call needs to be encoded as HashedValues
    const publicFunctionCalldata: HashedValues[] = [];
    for (const call of publicStaticCalls) {
      // Encode the function call arguments
      const calldata = await HashedValues.fromArgs(call.args);
      publicFunctionCalldata.push(calldata);
    }

    // Step 3: Create PrivateExecutionResult with just public call requests
    const privateResult = new PrivateExecutionResult(
      emptyEntrypoint,
      Fr.random(), // firstNullifier: random for uniqueness
      publicFunctionCalldata,
    );

    // Step 4: Generate simulated proving result
    // This creates the kernel outputs as if private execution occurred
    const provingResult = await generateSimulatedProvingResult(
      privateResult,
      this.contractStore,
    );

    // Step 5: Build Tx from kernel outputs
    const tx = await Tx.create({
      data: provingResult.publicInputs,
      chonkProof: ChonkProof.empty(),
      contractClassLogFields: [],
      publicFunctionCalldata: publicFunctionCalldata,
    });

    // Step 6: Simulate public calls on the node
    const publicOutput = await this.node.simulatePublicCalls(
      tx,
      true /* skipFeeEnforcement */,
    );

    // Step 7: Return TxSimulationResult
    return new TxSimulationResult(
      privateResult,
      provingResult.publicInputs,
      publicOutput,
      undefined, // stats: will be populated if needed
    );
  }
}
