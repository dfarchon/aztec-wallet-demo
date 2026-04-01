import { Fr } from "@aztec/aztec.js/fields";
import { useContext, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Snackbar from "@mui/material/Snackbar";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import { randomBytes } from "@aztec/foundation/crypto/random";
import Link from "@mui/material/Link";
import { AccountBox } from "./components/AccountBox.tsx";
import { DraggableFab } from "../../shared/DraggableFab.tsx";
import { WalletContext } from "../../../renderer";
import { useNetwork } from "../../../contexts/NetworkContext";
import type { InternalAccount } from "../../../../wallet/core/internal-wallet";

export function AccountsManager() {
  const [accounts, setAccounts] = useState<InternalAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [deployingAccount, setDeployingAccount] = useState<string | null>(null);

  const { walletAPI, embeddedMode, onRefreshAccounts } = useContext(WalletContext);
  const { currentNetwork } = useNetwork();

  const loadAccounts = async () => {
    const accounts = await walletAPI.getAccounts();
    setAccounts(accounts);
  };

  useEffect(() => {
    setLoading(true);
    loadAccounts().finally(() => setLoading(false));
  }, [currentNetwork.id, walletAPI]); // Reload when network changes

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      if (onRefreshAccounts) await onRefreshAccounts();
      await loadAccounts();
    } catch (err: any) {
      setError(err.message || "Failed to refresh accounts");
    } finally {
      setRefreshing(false);
    }
  };

  const handleCreateAccount = async () => {
    try {
      await walletAPI.createAccount(
        `ECDSAR1 ${accounts.length}`,
        "ecdsasecp256r1",
        Fr.random(),
        Fr.random(),
        randomBytes(32)
      );
      await loadAccounts();
    } catch (err: any) {
      setError(err.message || "Failed to create account");
    }
  };

  const handleDeployAccount = async (account: InternalAccount) => {
    setDeployingAccount(account.item.toString());
    try {
      await walletAPI.deployAccount(account.item);
      await loadAccounts();
    } catch (err: any) {
      setError(err.message || "Failed to deploy account");
      await loadAccounts();
    } finally {
      setDeployingAccount(null);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", gap: 2 }}>
        <CircularProgress size={32} />
        <Typography variant="body2" color="text.secondary">
          Loading accounts...
        </Typography>
      </Box>
    );
  }

  return (
    <>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Typography variant="h5" component="h2">
          Accounts
        </Typography>
        {embeddedMode && accounts.length === 0 ? (
          <Box sx={{ textAlign: "center", py: 4 }}>
            <Typography variant="body1" color="text.secondary" gutterBottom>
              No accounts found.
            </Typography>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              Create an account in the standalone wallet first.
            </Typography>
            <Box sx={{ display: "flex", gap: 2, justifyContent: "center", mt: 1 }}>
              <Link
                href={window.location.origin}
                target="_blank"
                rel="noopener"
              >
                Open wallet
              </Link>
              <Button
                variant="outlined"
                size="small"
                disabled={refreshing}
                onClick={handleRefresh}
              >
                {refreshing ? "Refreshing..." : "Refresh"}
              </Button>
            </Box>
          </Box>
        ) : (
          <Box
            sx={{
              display: "flex",
              width: "100%",
              flexDirection: "column",
              gap: 1,
            }}
          >
            {accounts.map((account, index) => (
              <AccountBox
                key={index}
                QRButton
                account={account}
                onDeploy={
                  embeddedMode ? undefined : () => handleDeployAccount(account)
                }
                isDeploying={
                  deployingAccount === account.item.toString() ||
                  account.deploymentStatus === "deploying"
                }
                showFundingHint={currentNetwork.id !== "localhost"}
              />
            ))}
            {embeddedMode && (
              <Button
                variant="text"
                size="small"
                disabled={refreshing}
                onClick={handleRefresh}
                sx={{ alignSelf: "center", mt: 1 }}
              >
                {refreshing ? "Refreshing..." : "Refresh accounts"}
              </Button>
            )}
          </Box>
        )}
      </Box>

      {/* Draggable FAB for creating accounts — hidden in embedded mode */}
      {!embeddedMode && <DraggableFab onClick={handleCreateAccount} />}
      <Snackbar
        open={error !== null}
        autoHideDuration={6000}
        onClose={() => setError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          onClose={() => setError(null)}
          severity="error"
          sx={{ width: "100%" }}
        >
          {error}
        </Alert>
      </Snackbar>
    </>
  );
}
