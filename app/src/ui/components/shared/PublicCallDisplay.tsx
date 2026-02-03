import type { PublicCallEvent } from "../../../wallet/decoding/tx-callstack-decoder";
import { FunctionCallDisplay } from "./FunctionCallDisplay";

export interface PublicCallDisplayProps {
  call: PublicCallEvent;
  accordionBgColor?: string;
}

/**
 * Display component for public calls.
 * Uses warning/orange coloring. Return values are shown when available.
 */
export function PublicCallDisplay({
  call,
  accordionBgColor = "rgba(255, 152, 0, 0.15)",
}: PublicCallDisplayProps) {
  return (
    <FunctionCallDisplay
      contractName={call.contract.name}
      contractAddress={call.contract.address}
      functionName={call.function}
      args={call.args}
      returnValues={call.returnValues ?? []}
      callerName={call.caller.name}
      typeLabel="Public"
      typeChipColor="warning"
      accentColor="warning.main"
      depth={call.depth}
      isStaticCall={call.isStaticCall}
      accordionBgColor={accordionBgColor}
    />
  );
}
