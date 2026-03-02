import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import type { ContractFunctionPattern } from "@aztec/aztec.js/wallet";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { SimulationCapability } from "./types";
import { groupPatternsByContract, formatContractAddress } from "./helpers";

interface SimulationCapabilityDetailsProps {
  capability: SimulationCapability;
  selectedKeys: Set<string>;
  contractMetadata: Map<string, string>;
  onTogglePattern: (storageKey: string) => void;
}

export function SimulationCapabilityDetails({
  capability,
  selectedKeys,
  contractMetadata,
  onTogglePattern,
}: SimulationCapabilityDetailsProps) {
  return (
    <Box>
      {/* Transaction Simulations Section */}
      {capability.transactions && (
        <Box sx={{ mb: 1 }}>
          <Typography
            variant="caption"
            sx={{ fontWeight: 600, display: "block", mb: 0.5 }}
          >
            Transaction Simulations (simulateTx)
          </Typography>
          {capability.transactions.scope === "*" ? (
            <Typography variant="caption" color="warning.main">
              ⚠️ Any transaction (wildcard)
            </Typography>
          ) : (
            <>
              {Array.from(
                groupPatternsByContract(
                  capability.transactions.scope as ContractFunctionPattern[],
                ).entries(),
              ).map(([contractKey, patternIndices]) => {
                const patterns = capability.transactions!
                  .scope as ContractFunctionPattern[];
                const contract = patterns[Array.from(patternIndices)[0]].contract;

                return (
                  <Box key={contractKey} sx={{ mb: 0.5 }}>
                    <Typography
                      variant="caption"
                      fontWeight={600}
                      sx={{ display: "block", mb: 0.25 }}
                    >
                      {contractKey === "*"
                        ? "Any Contract"
                        : formatContractAddress(
                            contract as AztecAddress,
                            contractMetadata,
                          )}
                    </Typography>
                    <Box
                      sx={{
                        ml: 1,
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 0.5,
                      }}
                    >
                      {Array.from(patternIndices).map((idx: number) => {
                        const pattern = patterns[idx];
                        const funcName =
                          pattern.function === "*"
                            ? "any function"
                            : pattern.function;
                        const storageKey = `simulateTx:${contractKey}:${pattern.function}`;

                        return (
                          <FormControlLabel
                            key={idx}
                            control={
                              <Checkbox
                                size="small"
                                checked={selectedKeys.has(storageKey)}
                                onChange={() => onTogglePattern(storageKey)}
                                sx={{ p: 0.25 }}
                              />
                            }
                            label={
                              <Typography
                                variant="caption"
                                sx={{
                                  fontFamily: "monospace",
                                  fontSize: "0.7rem",
                                }}
                              >
                                {funcName}
                              </Typography>
                            }
                            sx={{ m: 0, mr: 1 }}
                          />
                        );
                      })}
                    </Box>
                  </Box>
                );
              })}
            </>
          )}
        </Box>
      )}

      {/* Utility Simulations Section */}
      {capability.utilities && (
        <Box>
          <Typography
            variant="caption"
            sx={{
              fontWeight: 600,
              display: "block",
              mb: 0.5,
              mt: 1,
            }}
          >
            Utility Simulations (simulateUtility)
          </Typography>
          {capability.utilities.scope === "*" ? (
            <Typography variant="caption" color="warning.main">
              ⚠️ Any utility function (wildcard)
            </Typography>
          ) : (
            <>
              {Array.from(
                groupPatternsByContract(
                  capability.utilities.scope as ContractFunctionPattern[],
                ).entries(),
              ).map(([contractKey, patternIndices]) => {
                const patterns = capability.utilities!
                  .scope as ContractFunctionPattern[];
                const contract = patterns[Array.from(patternIndices)[0]].contract;

                return (
                  <Box key={`utility-${contractKey}`} sx={{ mb: 0.5 }}>
                    <Typography
                      variant="caption"
                      fontWeight={600}
                      sx={{ display: "block", mb: 0.25 }}
                    >
                      {contractKey === "*"
                        ? "Any Contract"
                        : formatContractAddress(
                            contract as AztecAddress,
                            contractMetadata,
                          )}
                    </Typography>
                    <Box
                      sx={{
                        ml: 1,
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 0.5,
                      }}
                    >
                      {Array.from(patternIndices).map((idx: number) => {
                        const pattern = patterns[idx];
                        const funcName =
                          pattern.function === "*"
                            ? "any function"
                            : pattern.function;
                        const storageKey = `simulateUtility:${contractKey}:${pattern.function}`;

                        return (
                          <FormControlLabel
                            key={idx}
                            control={
                              <Checkbox
                                size="small"
                                checked={selectedKeys.has(storageKey)}
                                onChange={() => onTogglePattern(storageKey)}
                                sx={{ p: 0.25 }}
                              />
                            }
                            label={
                              <Typography
                                variant="caption"
                                sx={{
                                  fontFamily: "monospace",
                                  fontSize: "0.7rem",
                                }}
                              >
                                {funcName}
                              </Typography>
                            }
                            sx={{ m: 0, mr: 1 }}
                          />
                        );
                      })}
                    </Box>
                  </Box>
                );
              })}
            </>
          )}
        </Box>
      )}
    </Box>
  );
}
