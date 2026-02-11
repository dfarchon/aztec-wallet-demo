import type { DecodedExecutionTrace } from "../../../wallet/decoding/tx-callstack-decoder";
import type { ReadableCallAuthorization } from "../../../wallet/decoding/call-authorization-formatter";
import { FunctionCallDisplay } from "./FunctionCallDisplay";
import { PrivateCallDisplay } from "./PrivateCallDisplay";
import { PublicCallDisplay } from "./PublicCallDisplay";
import {
  TransactionPhaseTimeline,
  type SimulationStats,
  type ProvingStats,
  type StoredPhaseTimings,
} from "./PhaseTimeline";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Paper from "@mui/material/Paper";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";

// Utility execution trace type
interface UtilityExecutionTrace {
  functionName: string;
  args: Array<{ name: string; value: string }>;
  contractAddress: string;
  contractName: string;
  result: string;
  isUtility: true;
}

interface ExecutionTraceDisplayProps {
  trace: DecodedExecutionTrace | UtilityExecutionTrace;
  callAuthorizations?: ReadableCallAuthorization[];
  accordionBgColor?: string;
  stats?: SimulationStats;
  provingStats?: ProvingStats;
  phaseTimings?: StoredPhaseTimings;
}

interface SimulationStatsDisplayProps {
  stats: SimulationStats;
  trace: DecodedExecutionTrace | UtilityExecutionTrace;
}

function SimulationStatsDisplay({ stats }: SimulationStatsDisplayProps) {
  const formatTime = (ms: number) => {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  // Only show if there are round trips to display
  if (!stats?.nodeRPCCalls?.roundTrips?.roundTripDurations?.length) {
    return null;
  }

  return (
    <Accordion
      defaultExpanded={false}
      sx={{ mb: 2, boxShadow: "none", "&:before": { display: "none" } }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreIcon />}
        sx={{
          minHeight: "auto",
          "& .MuiAccordionSummary-content": { my: 1 },
          bgcolor: "background.default",
          borderRadius: 1,
        }}
      >
        <Typography
          variant="subtitle2"
          sx={{ fontWeight: 600, color: "text.secondary" }}
        >
          RPC Round Trips (
          {stats.nodeRPCCalls.roundTrips.roundTripDurations.length})
        </Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 1, pb: 2 }}>
        <TableContainer
          component={Paper}
          variant="outlined"
          sx={{ maxHeight: 300 }}
        >
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Round Trip #</TableCell>
                <TableCell>Methods Called</TableCell>
                <TableCell align="right">Duration</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {stats.nodeRPCCalls.roundTrips.roundTripDurations.map(
                (duration, index) => {
                  const methods =
                    stats.nodeRPCCalls.roundTrips.roundTripMethods[index] || [];
                  return (
                    <TableRow key={index}>
                      <TableCell sx={{ fontFamily: "monospace" }}>
                        #{index + 1}
                      </TableCell>
                      <TableCell
                        sx={{ fontFamily: "monospace", fontSize: "0.75rem" }}
                      >
                        {methods.join(", ")}
                      </TableCell>
                      <TableCell align="right">
                        {formatTime(duration)}
                      </TableCell>
                    </TableRow>
                  );
                },
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </AccordionDetails>
    </Accordion>
  );
}

export function ExecutionTraceDisplay({
  trace,
  callAuthorizations,
  accordionBgColor,
  stats,
  provingStats,
  phaseTimings,
}: ExecutionTraceDisplayProps) {
  // Check if this is a utility trace
  if ("isUtility" in trace && trace.isUtility) {
    const utilityTrace = trace as UtilityExecutionTrace;

    // Convert result to return values format (result is already formatted as a string)
    const returnValues =
      utilityTrace.result !== undefined && utilityTrace.result !== ""
        ? [{ name: "result", value: utilityTrace.result }]
        : [];

    return (
      <>
        {/* Phase timeline for utility simulations */}
        {stats && (
          <Box sx={{ mb: 2 }}>
            <TransactionPhaseTimeline simulationStats={stats} size="normal" />
          </Box>
        )}
        <FunctionCallDisplay
          contractName={utilityTrace.contractName}
          contractAddress={utilityTrace.contractAddress}
          functionName={utilityTrace.functionName}
          args={utilityTrace.args}
          returnValues={returnValues}
          typeLabel="Utility"
          accordionBgColor={accordionBgColor}
        />
        {stats && <SimulationStatsDisplay stats={stats} trace={trace} />}
      </>
    );
  }

  // Full transaction trace
  const decodedTrace = trace as DecodedExecutionTrace;

  // Check if this is a public-only simulation (empty/mock private entrypoint)
  const isPublicOnly =
    decodedTrace.privateExecution.contract.address === AztecAddress.ZERO.toString();

  const publicCalls = decodedTrace.publicCalls ?? [];

  return (
    <>
      {/* Phase timeline showing simulation, proving, sending, mining times */}
      {(phaseTimings || stats || provingStats) && (
        <Box sx={{ mb: 2 }}>
          <TransactionPhaseTimeline
            simulationStats={stats}
            provingStats={provingStats}
            phaseTimings={phaseTimings}
            size="normal"
          />
        </Box>
      )}

      {/* Show private execution if this is not a public-only simulation */}
      {/* Public calls are rendered as nested events inside PrivateCallDisplay */}
      {!isPublicOnly && (
        <PrivateCallDisplay
          call={decodedTrace.privateExecution}
          authorizations={callAuthorizations}
          accordionBgColor={accordionBgColor}
        />
      )}

      {/* For public-only simulations (optimized), render public calls separately */}
      {isPublicOnly &&
        publicCalls.map((publicCall, idx) => (
          <PublicCallDisplay
            key={idx}
            call={publicCall}
            accordionBgColor={accordionBgColor}
          />
        ))}

      {stats && <SimulationStatsDisplay stats={stats} trace={trace} />}
    </>
  );
}
