import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { ContractsCapability } from "./types";

interface ContractsCapabilityDetailsProps {
  capability: ContractsCapability;
  contractPermissions: Map<string, { register: boolean; metadata: boolean }>;
  contractMetadata: Map<string, string>;
  onPermissionToggle: (addressStr: string, permType: "register" | "metadata") => void;
}

export function ContractsCapabilityDetails({
  capability,
  contractPermissions,
  contractMetadata,
  onPermissionToggle,
}: ContractsCapabilityDetailsProps) {
  if (capability.contracts === "*") {
    return (
      <Typography variant="caption" color="warning.main">
        ⚠️ All contracts (wildcard)
      </Typography>
    );
  }

  return (
    <Box>
      {(capability.contracts as AztecAddress[]).map((address) => {
        const addressStr = address.toString();
        const perms = contractPermissions.get(addressStr);
        const name = contractMetadata.get(addressStr);
        const shortAddr = `${addressStr.slice(0, 10)}...${addressStr.slice(-8)}`;

        return (
          <Box
            key={addressStr}
            sx={{
              mb: 0.5,
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              flexWrap: "wrap",
            }}
          >
            {name && (
              <Chip
                label={name}
                size="small"
                color="default"
                sx={{
                  fontWeight: 600,
                  height: 20,
                  fontSize: "0.7rem",
                }}
              />
            )}
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                fontFamily: "monospace",
                fontSize: "0.7rem",
              }}
            >
              {shortAddr}
            </Typography>
            {capability.canRegister && (
              <Chip
                label="Register"
                size="small"
                color={perms?.register ? "primary" : "default"}
                onClick={() => onPermissionToggle(addressStr, "register")}
                sx={{
                  cursor: "pointer",
                  height: 20,
                  fontSize: "0.7rem",
                }}
              />
            )}
            {capability.canGetMetadata && (
              <Chip
                label="Metadata"
                size="small"
                color={perms?.metadata ? "primary" : "default"}
                onClick={() => onPermissionToggle(addressStr, "metadata")}
                sx={{
                  cursor: "pointer",
                  height: 20,
                  fontSize: "0.7rem",
                }}
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
}
