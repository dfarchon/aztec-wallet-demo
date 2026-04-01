import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";

import IconButton from "@mui/material/IconButton";
import { useState } from "react";
import QrCode from "@mui/icons-material/QrCode";
import { QRDialog } from "../../../dialogs/QRDialog";
import type { InternalAccount } from "../../../../../wallet/core/internal-wallet";
import { formatFeeJuiceBalance } from "./fee-juice-format";

interface AccountBoxProps {
  account: InternalAccount;
  QRButton?: boolean;
  onDeploy?: () => void;
  isDeploying?: boolean;
  showFundingHint?: boolean;
}

const FUNDING_URL = "https://bridge.gregojuice.anothercoffeefor.me/";

function getStatusChipColor(status: InternalAccount["deploymentStatus"]) {
  switch (status) {
    case "deployed":
      return "success";
    case "deploying":
      return "warning";
    default:
      return "default";
  }
}

function getStatusLabel(status: InternalAccount["deploymentStatus"]) {
  switch (status) {
    case "deployed":
      return "Deployed";
    case "deploying":
      return "Deploying";
    default:
      return "Undeployed";
  }
}

export function AccountBox({
  account,
  QRButton = false,
  onDeploy,
  isDeploying = false,
  showFundingHint = false,
}: AccountBoxProps) {
  const [openQR, setOpenQR] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedFundingLink, setCopiedFundingLink] = useState(false);
  const deploymentStatus = isDeploying ? "deploying" : account.deploymentStatus;
  const showDeployAction = deploymentStatus !== "deployed" && !!onDeploy;
  const feeJuiceBalanceLabel =
    account.feeJuiceBalanceBaseUnits == null
      ? "unavailable"
      : formatFeeJuiceBalance(account.feeJuiceBalanceBaseUnits);

  const handleCopy = async () => {
    if (account.item) {
      await navigator.clipboard.writeText(account.item.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCopyFundingLink = async () => {
    await navigator.clipboard.writeText(FUNDING_URL);
    setCopiedFundingLink(true);
    setTimeout(() => setCopiedFundingLink(false), 2000);
  };

  return (
    <Card
      sx={{
        width: "100%",
        boxShadow: 2,
        transition: "box-shadow 0.2s, transform 0.2s",
        "&:hover": {
          boxShadow: 4,
          transform: "translateY(-2px)",
        },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          padding: "1rem",
          gap: 1,
        }}
      >
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography
            variant="subtitle2"
            sx={{
              fontWeight: 600,
              mb: 0.5,
            }}
          >
            {account.alias}
          </Typography>
          <Typography
            variant="body2"
            sx={{
              fontFamily: "monospace",
              fontSize: "0.75rem",
              color: "text.secondary",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {account.item ? account.item.toString() : "Uninitialized"}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              fontSize: "0.7rem",
            }}
          >
            {account.type}
          </Typography>
          {account.item && (
            <Typography
              variant="caption"
              sx={{
                display: "block",
                mt: 0.5,
                color: "text.secondary",
                fontSize: "0.7rem",
              }}
            >
              Fee juice: {feeJuiceBalanceLabel}
            </Typography>
          )}
          <Box sx={{ mt: 1, display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
            <Chip
              label={getStatusLabel(deploymentStatus)}
              color={getStatusChipColor(deploymentStatus)}
              size="small"
              variant={deploymentStatus === "undeployed" ? "outlined" : "filled"}
            />
            {isDeploying && <CircularProgress size={14} />}
          </Box>
        </Box>
        {account.item && (
          <IconButton
            size="small"
            onClick={handleCopy}
            sx={{
              color: copied ? "success.main" : "action.active",
            }}
          >
            {copied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
          </IconButton>
        )}
        {QRButton && account.item && (
          <IconButton size="small" onClick={() => setOpenQR(true)}>
            <QrCode fontSize="small" />
          </IconButton>
        )}
      </Box>
      {(showDeployAction || account.deploymentError) && (
        <Box
          sx={{
            px: 2,
            pb: 2,
            display: "flex",
            flexDirection: "column",
            gap: 1,
          }}
        >
          {account.deploymentError && deploymentStatus !== "deploying" && (
            <Typography variant="caption" color="error.main">
              {account.deploymentError}
            </Typography>
          )}
          {showFundingHint && deploymentStatus === "undeployed" && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
              <Typography variant="caption" color="text.secondary">
                Fund this address with fee juice, then deploy it.
              </Typography>
              <Button
                variant="text"
                size="small"
                startIcon={copiedFundingLink ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
                onClick={handleCopyFundingLink}
                sx={{ alignSelf: "flex-start", px: 0.5, minWidth: "auto" }}
              >
                {copiedFundingLink ? "Copied" : "Copy link"}
              </Button>
            </Box>
          )}
          {showDeployAction && (
            <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
              <Button
                variant="outlined"
                size="small"
                onClick={onDeploy}
                disabled={isDeploying}
              >
                Deploy
              </Button>
            </Box>
          )}
        </Box>
      )}
      {openQR && account.item && (
        <QRDialog
          open={openQR}
          onClose={() => setOpenQR(false)}
          address={account.item!.toString()}
        />
      )}
    </Card>
  );
}
