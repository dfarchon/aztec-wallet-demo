/**
 * IframeShell — wallet UI when embedded as a cross-origin iframe.
 *
 * Two-layer architecture:
 *
 * 1. IframeShell (outer) — starts immediately, no IndexedDB.
 *    - Starts IframeConnectionHandler (posts WALLET_READY for discovery)
 *    - Handles discovery auto-approval and key exchange
 *    - Gates storage access for cross-origin iframes (user gesture required)
 *    - Only renders the wallet UI after storage access is confirmed
 *
 * 2. WalletUI (inner) — rendered lazily after storage access is granted.
 *    - Creates WalletApi / WalletContext (triggers PXE + IndexedDB init)
 *    - Renders App, authorization dialogs, etc.
 */

import { StrictMode, useMemo, useState, useEffect, useRef, useCallback } from "react";
import {
  Box,
  Button,
  createTheme,
  CssBaseline,
  Link,
  type ThemeOptions,
  ThemeProvider,
  Typography,
  Dialog,
} from "@mui/material";
import {
  colors,
  WalletContext,
  NetworkProvider,
  useNetwork,
  App,
  AuthorizationDialog,
} from "@demo-wallet/shared/ui";
import {
  networkToChainInfo,
  type AuthorizationRequest,
} from "@demo-wallet/shared/core";
import { WalletApi, emitWalletUpdate } from "./utils/wallet-api.ts";
import {
  IframeConnectionHandler,
  type IframeConnectionConfig,
} from "../wallet/iframe-connection-handler.ts";
import { getOrCreateSession, bootstrapAccountsFromCookie, setCookiePassphrase, hasCookiePassphrase } from "../wallet/wallet-service.ts";
import { hasAccountsCookie, readAccountsCookie } from "../wallet/account-cookie.ts";
import { EmojiVerification } from "./components/EmojiVerification.tsx";
import { PinDialog } from "./components/PinDialog.tsx";
import { Fr } from "@aztec/aztec.js/fields";

const themeOptions: ThemeOptions = {
  breakpoints: {
    values: {
      xs: 0,
      sm: 360,
      md: 700,
      lg: 1200,
      xl: 1536,
    },
  },
  palette: {
    mode: "dark",
    primary: { main: colors.primary },
    secondary: { main: colors.secondary },
  },
  typography: {
    fontFamily: "monospace",
    subtitle2: { color: "darkgrey" },
  },
};
const theme = createTheme(themeOptions);

type StorageAccessState = "granted" | "needs-grant" | "needs-visit";

/**
 * Check whether we need a storage access grant.
 * Resolves to "granted" immediately when not in an iframe or already have access.
 */
async function checkStorageAccess(): Promise<StorageAccessState> {
  if (window.self === window.top || !document.hasStorageAccess) return "granted";
  const has = await document.hasStorageAccess();
  return has ? "granted" : "needs-grant";
}

// ─── Inner: wallet UI (only mounted after storage access is confirmed) ───

function WalletUI({
  authQueue,
  setAuthQueue,
  verificationHash,
}: {
  authQueue: AuthorizationRequest[];
  setAuthQueue: React.Dispatch<React.SetStateAction<AuthorizationRequest[]>>;
  verificationHash: string | null;
}) {
  const { currentNetwork } = useNetwork();
  const chainInfo = networkToChainInfo(currentNetwork);

  const walletAPI = useMemo(
    () => WalletApi.create(chainInfo.chainId, chainInfo.version),
    [currentNetwork.id],
  );
  const onRefreshAccounts = useCallback(async () => {
    await bootstrapAccountsFromCookie({ chainId: chainInfo.chainId, version: chainInfo.version });
  }, [chainInfo.chainId, chainInfo.version]);

  const walletContext = useMemo(
    () => ({ walletAPI, embeddedMode: true, onRefreshAccounts }),
    [walletAPI, onRefreshAccounts],
  );
  const currentAuth = authQueue[0] ?? null;

  const handleAuthApprove = (itemResponses: Record<string, any>) => {
    if (currentAuth) {
      walletAPI.resolveAuthorization({
        id: currentAuth.id,
        approved: true,
        appId: currentAuth.appId,
        itemResponses,
      });
      setAuthQueue((prev) => prev.slice(1));
    }
  };

  const handleAuthDeny = () => {
    if (currentAuth) {
      const itemResponses: Record<string, any> = {};
      for (const item of currentAuth.items) {
        itemResponses[item.id] = { id: item.id, approved: false, appId: item.appId };
      }
      walletAPI.resolveAuthorization({
        id: currentAuth.id,
        approved: false,
        appId: currentAuth.appId,
        itemResponses,
      });
      setAuthQueue((prev) => prev.slice(1));
    }
  };

  return (
    <WalletContext.Provider value={walletContext}>
      <CssBaseline />
      <App />
      {/* Overlay: emoji verification during key exchange */}
      <Dialog open={!!verificationHash} fullScreen>
        <EmojiVerification verificationHash={verificationHash ?? ""} />
      </Dialog>
      {/* Overlay: dApp authorization requests */}
      {currentAuth && (
        <AuthorizationDialog
          request={currentAuth}
          queueLength={authQueue.length}
          onApprove={handleAuthApprove}
          onDeny={handleAuthDeny}
        />
      )}
    </WalletContext.Provider>
  );
}

// ─── Outer: connection handler + storage access gate ───

function IframeContent() {
  const { currentNetwork } = useNetwork();

  const [storageAccess, setStorageAccess] = useState<StorageAccessState | "checking">("checking");
  const [pinState, setPinState] = useState<"checking" | "needs-pin" | "no-cookie" | "ready">("checking");
  const [pinError, setPinError] = useState<string | null>(null);
  const [authQueue, setAuthQueue] = useState<AuthorizationRequest[]>([]);
  const [verificationHash, setVerificationHash] = useState<string | null>(null);
  const clearVerificationHash = useCallback(() => setVerificationHash(null), []);

  const clearVerificationHashRef = useRef(clearVerificationHash);
  useEffect(() => { clearVerificationHashRef.current = clearVerificationHash; }, [clearVerificationHash]);

  const enqueueAuthRequest = useCallback((request: AuthorizationRequest) => {
    setAuthQueue((prev) => {
      if (prev.some((r) => r.id === request.id)) return prev;
      return [...prev, request];
    });
  }, []);
  const enqueueAuthRef = useRef(enqueueAuthRequest);
  useEffect(() => { enqueueAuthRef.current = enqueueAuthRequest; }, [enqueueAuthRequest]);

  // Check storage access on mount
  useEffect(() => {
    checkStorageAccess().then(setStorageAccess);
  }, []);

  // After storage access is granted, check for cookie
  useEffect(() => {
    if (storageAccess !== "granted") return;
    if (hasCookiePassphrase()) {
      setPinState("ready");
    } else if (hasAccountsCookie()) {
      setPinState("needs-pin");
    } else {
      setPinState("no-cookie");
    }
  }, [storageAccess]);

  const handlePinSubmit = useCallback(async (pin: string) => {
    setPinError(null);
    try {
      await readAccountsCookie(pin); // verify decryption works
      setCookiePassphrase(pin);
      setPinState("ready");
    } catch {
      setPinError("Wrong PIN. Please try again.");
    }
  }, []);

  // Start the IframeConnectionHandler immediately — no IndexedDB needed for
  // discovery or key exchange. getExternalWallet is only called after the dApp
  // sends its first real message, by which point storage access is granted.
  useEffect(() => {
    const config: IframeConnectionConfig = {
      walletId: "demo-web-wallet",
      walletName: "Aztec Web Demo Wallet",
      walletVersion: "0.1.0",
      allowedOrigins: [],
    };

    const handler = new IframeConnectionHandler(config, {
      onPendingDiscovery: (session) => {
        handler.approveDiscovery(session.requestId);
      },
      onVerificationHash: (hash) => {
        setVerificationHash(hash);
      },
      getExternalWallet: async (appId, chainInfo) => {
        clearVerificationHashRef.current();
        const rawChainId = (chainInfo as any).chainId;
        const rawVersion = (chainInfo as any).version;
        const chainId = rawChainId instanceof Fr ? rawChainId : Fr.fromString(String(rawChainId));
        const version = rawVersion instanceof Fr ? rawVersion : Fr.fromString(String(rawVersion));

        // Ensure storage access for cookies before PXE init
        if (document.requestStorageAccess) {
          try { await document.requestStorageAccess(); } catch { /* already granted or not needed */ }
        }

        const normalizedChainInfo = { chainId, version };
        const { external } = await getOrCreateSession(
          normalizedChainInfo,
          appId,
          (eventType, detail) => {
            if (eventType === "wallet-update") {
              emitWalletUpdate(detail);
            } else if (eventType === "authorization-request") {
              const request: AuthorizationRequest =
                typeof detail === "string" ? JSON.parse(detail) : detail;
              enqueueAuthRef.current(request);
            }
          },
        );

        // Bootstrap accounts from cookie into the partitioned WalletDB
        await bootstrapAccountsFromCookie(normalizedChainInfo);

        return external;
      },
    });

    handler.start();
    return () => handler.stop();
  }, [currentNetwork.id]);

  const handleGrantClick = useCallback(async () => {
    try {
      await document.requestStorageAccess();
      setStorageAccess("granted");
    } catch {
      setStorageAccess("needs-visit");
    }
  }, []);

  const handleRetryClick = useCallback(async () => {
    const has = await document.hasStorageAccess();
    setStorageAccess(has ? "granted" : "needs-grant");
  }, []);

  if (storageAccess === "checking") return <CssBaseline />;

  if (storageAccess !== "granted") {
    return (
      <>
        <CssBaseline />
        <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", gap: 2, p: 3, textAlign: "center" }}>
          <Typography variant="h6">Aztec Web Demo Wallet</Typography>
          {storageAccess === "needs-grant" && (
            <>
              <Typography variant="body2" color="text.secondary">
                This wallet needs access to its storage to function.
              </Typography>
              <Button variant="contained" onClick={handleGrantClick}>
                Authorize Storage Access
              </Button>
            </>
          )}
          {storageAccess === "needs-visit" && (
            <>
              <Typography variant="body2" color="text.secondary">
                Your browser requires you to visit the wallet site directly before it can be used in an iframe.
              </Typography>
              <Link href={window.location.origin} target="_blank" rel="noopener">
                Open wallet in a new tab
              </Link>
              <Button variant="outlined" onClick={handleRetryClick} sx={{ mt: 1 }}>
                Retry
              </Button>
            </>
          )}
        </Box>
      </>
    );
  }

  // Storage access granted — now gate on PIN

  if (pinState === "checking") return <CssBaseline />;

  if (pinState === "no-cookie") {
    return (
      <>
        <CssBaseline />
        <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", gap: 2, p: 3, textAlign: "center" }}>
          <Typography variant="h6">Aztec Web Demo Wallet</Typography>
          <Typography variant="body2" color="text.secondary">
            No wallet accounts found. Create an account in the standalone wallet first.
          </Typography>
          <Link href={window.location.origin} target="_blank" rel="noopener">
            Open wallet
          </Link>
        </Box>
      </>
    );
  }

  if (pinState === "needs-pin") {
    return (
      <>
        <CssBaseline />
        <PinDialog open mode="enter" error={pinError} onSubmit={handlePinSubmit} />
      </>
    );
  }

  // PIN verified — mount the wallet UI (triggers PXE + IndexedDB init)
  return (
    <WalletUI
      authQueue={authQueue}
      setAuthQueue={setAuthQueue}
      verificationHash={verificationHash}
    />
  );
}

export function IframeShell() {
  return (
    <StrictMode>
      <ThemeProvider theme={theme}>
        <NetworkProvider>
          <IframeContent />
        </NetworkProvider>
      </ThemeProvider>
    </StrictMode>
  );
}
