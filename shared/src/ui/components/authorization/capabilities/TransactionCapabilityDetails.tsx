import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import type { ContractFunctionPattern } from "@aztec/aztec.js/wallet";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { TransactionCapability } from "./types";
import { groupPatternsByContract, formatContractAddress } from "./helpers";

interface TransactionCapabilityDetailsProps {
  capability: TransactionCapability;
  contractMetadata: Map<string, string>;
}

export function TransactionCapabilityDetails({
  capability,
  contractMetadata,
}: TransactionCapabilityDetailsProps) {
  if (capability.scope === "*") {
    return (
      <Typography variant="caption" color="warning.main">
        ⚠️ Any transaction (wildcard)
      </Typography>
    );
  }

  return (
    <Box>
      {Array.from(
        groupPatternsByContract(
          capability.scope as ContractFunctionPattern[],
        ).entries(),
      ).map(([contractKey, patternIndices]) => {
        const patterns = capability.scope as ContractFunctionPattern[];
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

                return (
                  <Chip
                    key={idx}
                    label={funcName}
                    size="small"
                    variant="outlined"
                    sx={{
                      height: 20,
                      fontSize: "0.7rem",
                      fontFamily: "monospace",
                    }}
                  />
                );
              })}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
