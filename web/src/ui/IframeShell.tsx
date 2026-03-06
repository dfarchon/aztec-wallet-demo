/**
 * IframeShell — wallet UI when embedded as a cross-origin iframe.
 *
 * Centralized gating flow (all gates in IframeContent):
 *
 *   1. Storage access check — request unpartitioned cookie access
 *   2. Cookie check — does an encrypted accounts cookie exist?
 *   3. PIN gate — user enters PIN to decrypt accounts
 *   4. WalletUI — PXE init, account bootstrap, wallet rendering
 *
 * The IframeConnectionHandler starts immediately (no storage needed for
 * discovery / key exchange). getExternalWallet awaits the PIN gate before
 * bootstrapping accounts from the cookie.
 */

import {
  StrictMode,
  useMemo,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
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
import {
  getOrCreateSession,
  setCookiePassphrase,
  hasCookiePassphrase,
} from "../wallet/wallet-service.ts";
import {
  hasAccountsCookie,
  readAccountsCookie,
} from "../wallet/account-cookie.ts";
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

/**
 * Check whether we already have storage access.
 * Returns true if not in an iframe or if access is already granted.
 */
async function hasStorageAccessAlready(): Promise<boolean> {
  if (window.self === window.top || !document.hasStorageAccess) return true;
  return document.hasStorageAccess();
}

// ─── Inner: wallet UI (only mounted after all gates pass) ───

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
    const normalizedChainInfo = {
      chainId: chainInfo.chainId,
      version: chainInfo.version,
    };
    await getOrCreateSession(normalizedChainInfo, "refresh", () => {});
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
        itemResponses[item.id] = {
          id: item.id,
          approved: false,
          appId: item.appId,
        };
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

// ─── Gate pages (themed inline, no ThemeProvider needed) ───

function StorageAccessGate({
  state,
  onRetry,
}: {
  state: "needs-visit";
  onRetry: () => void;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        gap: 2,
        p: 3,
        textAlign: "center",
      }}
    >
      <Typography variant="h6">Aztec Web Demo Wallet</Typography>
      <Typography variant="body2" color="text.secondary">
        Your browser requires you to visit the wallet site directly before it
        can be used in an iframe.
      </Typography>
      <Link href={window.location.origin} target="_blank" rel="noopener">
        Open wallet in a new tab
      </Link>
      <Button variant="outlined" onClick={onRetry} sx={{ mt: 1 }}>
        Retry
      </Button>
    </Box>
  );
}

function NoCookieGate() {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        gap: 2,
        p: 3,
        textAlign: "center",
      }}
    >
      <Typography variant="h6">Aztec Web Demo Wallet</Typography>
      <Typography variant="body2" color="text.secondary">
        No wallet accounts found. Create an account in the standalone wallet
        first.
      </Typography>
      <Link href={window.location.origin} target="_blank" rel="noopener">
        Open wallet
      </Link>
    </Box>
  );
}

// ─── Outer: centralized gating ───

function IframeContent() {
  const { currentNetwork } = useNetwork();

  // Single gate state: checking → needs-pin → needs-visit → no-cookie → ready
  type GateState =
    | "checking"
    | "needs-pin"
    | "needs-visit"
    | "no-cookie"
    | "ready";
  const [gate, setGate] = useState<GateState>("checking");
  const [pinError, setPinError] = useState<string | null>(null);

  // Wallet state (only used after gate === "ready")
  const [authQueue, setAuthQueue] = useState<AuthorizationRequest[]>([]);
  const [verificationHash, setVerificationHash] = useState<string | null>(null);
  const clearVerificationHash = useCallback(
    () => setVerificationHash(null),
    [],
  );

  const clearVerificationHashRef = useRef(clearVerificationHash);
  useEffect(() => {
    clearVerificationHashRef.current = clearVerificationHash;
  }, [clearVerificationHash]);

  const enqueueAuthRequest = useCallback((request: AuthorizationRequest) => {
    setAuthQueue((prev) => {
      if (prev.some((r) => r.id === request.id)) return prev;
      return [...prev, request];
    });
  }, []);
  const enqueueAuthRef = useRef(enqueueAuthRequest);
  useEffect(() => {
    enqueueAuthRef.current = enqueueAuthRequest;
  }, [enqueueAuthRequest]);

  // ─── PIN gate promise ───
  // getExternalWallet awaits this before bootstrapping accounts from cookie.
  // Resolved when the PIN is verified or passphrase is already set.
  const pinGateRef = useRef<{ resolve: () => void; promise: Promise<void> }>(
    null!,
  );
  if (!pinGateRef.current) {
    let resolve: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    pinGateRef.current = { resolve: resolve!, promise };
  }

  // ─── Initial check: storage access + cookie + passphrase ───

  useEffect(() => {
    (async () => {
      const granted = await hasStorageAccessAlready();
      if (granted) {
        // Already have storage access — check cookie state
        if (hasCookiePassphrase()) {
          setGate("ready");
          pinGateRef.current.resolve();
        } else if (hasAccountsCookie()) {
          setGate("needs-pin");
        } else {
          setGate("no-cookie");
        }
      } else {
        // No storage access yet — show PIN dialog immediately.
        // Storage access will be requested on the user's button click (user gesture).
        setGate("needs-pin");
      }
    })();
  }, []);

  // ─── Combined PIN submit + storage access request ───
  // The user's click on "Unlock" is a user gesture, which satisfies
  // the browser's requirement for requestStorageAccess().

  const handlePinSubmit = useCallback(async (pin: string) => {
    setPinError(null);

    // Request storage access if we don't have it yet (user gesture required)
    if (document.requestStorageAccess) {
      try {
        await document.requestStorageAccess();
      } catch {
        // Browser requires a first-party visit before granting storage access
        setGate("needs-visit");
        return;
      }
    }

    // Now we have cookie access — verify the PIN
    if (!hasAccountsCookie()) {
      setGate("no-cookie");
      return;
    }

    try {
      await readAccountsCookie(pin); // verify decryption works
      setCookiePassphrase(pin);
      setGate("ready");
      pinGateRef.current.resolve(); // unblock getExternalWallet
    } catch {
      setPinError("Wrong PIN. Please try again.");
    }
  }, []);

  const handleRetryClick = useCallback(async () => {
    const has = await document.hasStorageAccess();
    setGate(has ? "needs-pin" : "needs-visit");
  }, []);

  // ─── Connection handler (starts immediately, no storage needed) ───

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
        const chainId =
          rawChainId instanceof Fr
            ? rawChainId
            : Fr.fromString(String(rawChainId));
        const version =
          rawVersion instanceof Fr
            ? rawVersion
            : Fr.fromString(String(rawVersion));

        // Ensure storage access for cookies before PXE init
        if (document.requestStorageAccess) {
          try {
            await document.requestStorageAccess();
          } catch {
            /* already granted or not needed */
          }
        }

        // Wait for the user to enter the PIN before proceeding.
        // This blocks until handlePinSubmit resolves the gate.
        await pinGateRef.current.promise;

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

        return external;
      },
    });

    handler.start();
    return () => handler.stop();
  }, [currentNetwork.id]);

  // ─── Render: centralized gate sequence ───

  if (gate === "checking") {
    return <CssBaseline />;
  }

  if (gate === "needs-visit") {
    return (
      <>
        <CssBaseline />
        <StorageAccessGate state="needs-visit" onRetry={handleRetryClick} />
      </>
    );
  }

  if (gate === "no-cookie") {
    return (
      <>
        <CssBaseline />
        <NoCookieGate />
      </>
    );
  }

  if (gate === "needs-pin") {
    return (
      <>
        <CssBaseline />
        <PinDialog mode="enter" error={pinError} onSubmit={handlePinSubmit} />
      </>
    );
  }

  // All gates passed — mount the wallet UI
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
