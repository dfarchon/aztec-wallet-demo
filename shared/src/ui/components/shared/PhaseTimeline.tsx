import { useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";

/**
 * Per-function timing entry from simulation/proving stats
 */
interface FunctionTiming {
  functionName: string;
  time: number;
  oracles?: Record<string, { times: number[] }>;
}

/**
 * Timing breakdown from simulation or proving stats
 */
interface StatsTimings {
  sync: number;
  publicSimulation?: number;
  validation?: number;
  proving?: number; // Only present in ProvingStats - actual proof generation time
  perFunction: FunctionTiming[];
  unaccounted: number;
  total: number;
}

/**
 * Simulation stats structure from TxSimulationResult
 */
export interface SimulationStats {
  timings: StatsTimings;
  nodeRPCCalls?: {
    perMethod: Partial<Record<string, { times: number[] }>>;
    roundTrips: {
      roundTripDurations: number[];
      roundTripMethods: string[][];
    };
  };
}

/**
 * Proving stats structure from TxProvingResult
 */
export interface ProvingStats {
  timings: StatsTimings;
}

/**
 * Phase timings stored with transaction interactions
 */
export interface StoredPhaseTimings {
  simulation?: number;
  proving?: number;
  sending?: number;
  mining?: number;
}

/**
 * Phase timing data for a single phase
 */
export interface PhaseTiming {
  name: string;
  duration: number; // milliseconds
  color: string;
  breakdown?: Array<{ label: string; duration: number }>;
}

/**
 * Props for the PhaseTimeline component
 */
interface PhaseTimelineProps {
  phases: PhaseTiming[];
  /** Component size variant - affects detail level */
  size?: "compact" | "normal" | "detailed";
  /** If true, show labels inside segments */
  showLabels?: boolean;
  /** Custom height for the timeline bar */
  height?: number;
}

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
};

const formatDurationLong = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} milliseconds`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} seconds`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
};

/**
 * Extracts phase timings from simulation stats
 */
export function extractPhasesFromStats(stats: SimulationStats | ProvingStats | undefined): PhaseTiming[] {
  if (!stats?.timings) return [];

  const phases: PhaseTiming[] = [];
  const timings = stats.timings;

  // Sync phase
  if (timings.sync > 0) {
    phases.push({
      name: "Sync",
      duration: timings.sync,
      color: "#90caf9", // light blue
    });
  }

  // Per-function (witness generation) phase
  if (timings.perFunction?.length > 0) {
    const witgenTotal = timings.perFunction.reduce(
      (sum, fn) => sum + fn.time,
      0
    );
    phases.push({
      name: "Witgen",
      duration: witgenTotal,
      color: "#ffb74d", // orange
      breakdown: timings.perFunction.map((fn) => ({
        label: fn.functionName.split(":").pop() || fn.functionName,
        duration: fn.time,
      })),
    });
  }

  // Public simulation phase
  if (timings.publicSimulation && timings.publicSimulation > 0) {
    phases.push({
      name: "Public Sim",
      duration: timings.publicSimulation,
      color: "#81c784", // green
    });
  }

  // Validation phase
  if (timings.validation && timings.validation > 0) {
    phases.push({
      name: "Validation",
      duration: timings.validation,
      color: "#ce93d8", // purple
    });
  }

  // Proving phase (only exists in ProvingStats - actual proof generation)
  if (timings.proving && timings.proving > 0) {
    phases.push({
      name: "Proving",
      duration: timings.proving,
      color: "#f48fb1", // pink
    });
  }

  // Unaccounted time
  if (timings.unaccounted > 0) {
    phases.push({
      name: "Other",
      duration: timings.unaccounted,
      color: "#bdbdbd", // gray
    });
  }

  return phases;
}

/**
 * Extracts phase timings from phase timing data stored with interaction.
 *
 * IMPORTANT: When provingStats is available, it REPLACES simulationStats entirely.
 * The timeline shows what actually happened during proving, not the prepare-phase simulation.
 *
 * The breakdown (Sync, Witgen with perFunction, Other) comes from:
 * - provingStats if available (after tx is sent)
 * - simulationStats as fallback (before proving completes)
 *
 * Phases shown:
 * - Sync, Witgen (with perFunction breakdown), Other (from stats)
 * - Sending (wall clock time)
 * - Mining (wall clock time)
 */
export function extractPhasesFromPhaseTimings(
  phaseTimings: StoredPhaseTimings | undefined,
  simulationStats?: SimulationStats,
  provingStats?: ProvingStats
): PhaseTiming[] {
  if (!phaseTimings) return [];

  const phases: PhaseTiming[] = [];

  // Use provingStats if available (REPLACES simulation stats), otherwise use simulationStats
  // provingStats represents what actually happened during proving
  const stats = provingStats || simulationStats;

  if (stats?.timings) {
    const timings = stats.timings;

    // Sync phase
    if (timings.sync > 0) {
      phases.push({
        name: "Sync",
        duration: timings.sync,
        color: "#90caf9", // light blue
      });
    }

    // Witgen phase (witness generation) with perFunction breakdown
    if (timings.perFunction?.length > 0) {
      const witgenTotal = timings.perFunction.reduce(
        (sum, fn) => sum + fn.time,
        0
      );
      phases.push({
        name: "Witgen",
        duration: witgenTotal,
        color: "#ffb74d", // orange
        breakdown: timings.perFunction.map((fn) => ({
          label: fn.functionName.split(":").pop() || fn.functionName,
          duration: fn.time,
        })),
      });
    }

    // Public simulation phase (only from simulationStats, not during proving)
    if (!provingStats && timings.publicSimulation && timings.publicSimulation > 0) {
      phases.push({
        name: "Public Sim",
        duration: timings.publicSimulation,
        color: "#81c784", // green
      });
    }

    // Validation phase (only from simulationStats, not during proving)
    if (!provingStats && timings.validation && timings.validation > 0) {
      phases.push({
        name: "Validation",
        duration: timings.validation,
        color: "#ce93d8", // purple
      });
    }

    // Proving phase (only exists in ProvingStats - actual proof generation)
    if (timings.proving && timings.proving > 0) {
      phases.push({
        name: "Proving",
        duration: timings.proving,
        color: "#f48fb1", // pink
      });
    }

    // Unaccounted time
    if (timings.unaccounted > 0) {
      phases.push({
        name: "Other",
        duration: timings.unaccounted,
        color: "#bdbdbd", // gray
      });
    }
  }

  if (phaseTimings.sending && phaseTimings.sending > 0) {
    phases.push({
      name: "Sending",
      duration: phaseTimings.sending,
      color: "#2196f3", // blue
    });
  }

  if (phaseTimings.mining && phaseTimings.mining > 0) {
    phases.push({
      name: "Mining",
      duration: phaseTimings.mining,
      color: "#4caf50", // green
    });
  }

  return phases;
}

/**
 * Phase timeline tooltip content
 */
function PhaseTooltipContent({ phase, percentage }: { phase: PhaseTiming; percentage: number }) {
  return (
    <Box sx={{ p: 0.5 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
        {phase.name}
      </Typography>
      <Typography variant="body2">
        {formatDurationLong(phase.duration)} ({percentage.toFixed(1)}%)
      </Typography>
      {phase.breakdown && phase.breakdown.length > 0 && (
        <Box sx={{ mt: 1, pl: 1, borderLeft: "2px solid", borderColor: "divider" }}>
          {phase.breakdown.map((item, idx) => (
            <Typography key={idx} variant="caption" sx={{ display: "block" }}>
              {item.label}: {formatDuration(item.duration)}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}

/**
 * Reusable phase timeline component that displays execution phases as a visual timeline bar.
 *
 * Features:
 * - Proportional width segments for each phase
 * - Hover tooltips with detailed breakdown
 * - Responsive size variants (compact, normal, detailed)
 * - Total time display
 * - Customizable colors per phase
 */
export function PhaseTimeline({
  phases,
  size = "normal",
  showLabels = true,
  height,
}: PhaseTimelineProps) {
  const [hoveredPhase, setHoveredPhase] = useState<string | null>(null);

  const { totalDuration, preparingDuration, miningDuration } = useMemo(() => {
    let total = 0;
    let mining = 0;
    for (const phase of phases) {
      total += phase.duration;
      if (phase.name === "Mining") {
        mining += phase.duration;
      }
    }
    return {
      totalDuration: total,
      miningDuration: mining,
      preparingDuration: total - mining,
    };
  }, [phases]);

  if (phases.length === 0 || totalDuration === 0) {
    return null;
  }

  const barHeight = height ?? (size === "compact" ? 8 : size === "normal" ? 16 : 24);
  const showSegmentLabels = showLabels && size !== "compact";
  const minSegmentWidthForLabel = size === "detailed" ? 40 : 60;
  const hasMining = miningDuration > 0;

  return (
    <Box sx={{ width: "100%" }}>
      {/* Time chips and legend */}
      {size !== "compact" && (
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            mb: 0.5,
          }}
        >
          <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
            {hasMining ? (
              // Show: Preparing TX | Mining | Total
              <>
                <Chip
                  label={`Preparing TX: ${formatDuration(preparingDuration)}`}
                  size="small"
                  sx={{ height: 20, fontSize: "0.65rem", fontWeight: 600, bgcolor: "#1565c0", color: "white" }}
                />
                <Chip
                  label={`Mining: ${formatDuration(miningDuration)}`}
                  size="small"
                  sx={{ height: 20, fontSize: "0.65rem", fontWeight: 600, bgcolor: "#4caf50", color: "white" }}
                />
                <Chip
                  label={`Total: ${formatDuration(totalDuration)}`}
                  size="small"
                  sx={{ height: 20, fontSize: "0.65rem", fontWeight: 600 }}
                />
              </>
            ) : (
              // Just show total (simulation only, no mining)
              <Chip
                label={`Total: ${formatDuration(totalDuration)}`}
                size="small"
                sx={{ height: 20, fontSize: "0.7rem", fontWeight: 600 }}
              />
            )}
          </Box>
          {size === "detailed" && (
            <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
              {phases.map((phase) => (
                <Box
                  key={phase.name}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 0.5,
                  }}
                >
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      bgcolor: phase.color,
                    }}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {phase.name}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}

      {/* Timeline bar */}
      <Box
        sx={{
          display: "flex",
          width: "100%",
          height: barHeight,
          borderRadius: 1,
          overflow: "hidden",
          bgcolor: "action.hover",
        }}
      >
        {phases.map((phase, index) => {
          const percentage = (phase.duration / totalDuration) * 100;
          const segmentWidth = `${percentage}%`;
          const showLabel =
            showSegmentLabels &&
            percentage > (100 * minSegmentWidthForLabel) / 300; // Rough calculation for label fit

          return (
            <Tooltip
              key={phase.name}
              title={<PhaseTooltipContent phase={phase} percentage={percentage} />}
              arrow
              placement="top"
            >
              <Box
                onMouseEnter={() => setHoveredPhase(phase.name)}
                onMouseLeave={() => setHoveredPhase(null)}
                sx={{
                  width: segmentWidth,
                  minWidth: percentage > 0 ? 2 : 0, // Minimum visible width
                  height: "100%",
                  bgcolor: phase.color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "all 0.2s ease",
                  cursor: "pointer",
                  borderRight:
                    index < phases.length - 1
                      ? "1px solid rgba(255,255,255,0.3)"
                      : undefined,
                  transform: hoveredPhase === phase.name ? "scaleY(1.1)" : "scaleY(1)",
                  zIndex: hoveredPhase === phase.name ? 1 : 0,
                  "&:hover": {
                    filter: "brightness(1.1)",
                  },
                }}
              >
                {showLabel && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: "rgba(0,0,0,0.7)",
                      fontWeight: 600,
                      fontSize: size === "detailed" ? "0.65rem" : "0.6rem",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      px: 0.5,
                    }}
                  >
                    {phase.name}
                  </Typography>
                )}
              </Box>
            </Tooltip>
          );
        })}
      </Box>

      {/* Compact mode total time below */}
      {size === "compact" && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontSize: "0.65rem", mt: 0.25, display: "block" }}
        >
          {formatDuration(totalDuration)}
        </Typography>
      )}
    </Box>
  );
}

/**
 * Convenience component that extracts phases from stats automatically
 */
export function SimulationPhaseTimeline({
  stats,
  size = "normal",
}: {
  stats: SimulationStats | ProvingStats | undefined;
  size?: "compact" | "normal" | "detailed";
}) {
  const phases = useMemo(() => extractPhasesFromStats(stats), [stats]);
  return <PhaseTimeline phases={phases} size={size} />;
}

/**
 * Convenience component for sendTx interactions showing all phases.
 * For sent transactions: shows Sync, Witgen, Other (from simulationStats), then Proving, Sending, Mining.
 * For simulations only: shows breakdown from simulationStats.
 */
export function TransactionPhaseTimeline({
  simulationStats,
  phaseTimings,
  provingStats,
  size = "normal",
}: {
  simulationStats?: SimulationStats;
  phaseTimings?: StoredPhaseTimings;
  provingStats?: ProvingStats;
  size?: "compact" | "normal" | "detailed";
}) {
  const phases = useMemo(() => {
    // If we have detailed phase timings (sent tx), use those with stats for breakdown
    if (phaseTimings) {
      return extractPhasesFromPhaseTimings(phaseTimings, simulationStats, provingStats);
    }
    // Otherwise fall back to simulation stats only (simulate without send)
    if (simulationStats) {
      return extractPhasesFromStats(simulationStats);
    }
    return [];
  }, [simulationStats, phaseTimings, provingStats]);

  return <PhaseTimeline phases={phases} size={size} />;
}
