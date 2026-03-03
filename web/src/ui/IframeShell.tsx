/**
 * IframeShell — wallet UI when embedded as a cross-origin iframe.
 *
 * Responsibilities:
 * 1. Start the IframeConnectionHandler to handle postMessage protocol
 * 2. Show authorization dialogs when dApp requests require user approval
 * 3. Auto-approve discovery for the prototype (can be replaced with UI later)
 *
 * The shell is minimal — no navigation, no account management — just the
 * authorization flow that requires wallet-side user interaction.
 */

import { StrictMode, useMemo, useState, useEffect, useRef, useCallback } from "react";
import {
  createTheme,
  CssBaseline,
  type ThemeOptions,
  ThemeProvider,
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
import { getOrCreateSession } from "../wallet/wallet-service.ts";
import { EmojiVerification } from "./components/EmojiVerification.tsx";
import { Fr } from "@aztec/aztec.js/fields";

const themeOptions: ThemeOptions = {
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

function IframeContent() {
  const { currentNetwork } = useNetwork();
  const chainInfo = networkToChainInfo(currentNetwork);

  const walletAPI = useMemo(
    () => WalletApi.create(chainInfo.chainId, chainInfo.version),
    [currentNetwork.id],
  );
  const walletContext = useMemo(() => ({ walletAPI }), [walletAPI]);

  const [authQueue, setAuthQueue] = useState<AuthorizationRequest[]>([]);
  const currentAuth = authQueue[0] ?? null;
  // verificationHash: set during key exchange, cleared when the first wallet message arrives
  const [verificationHash, setVerificationHash] = useState<string | null>(null);
  const clearVerificationHash = useCallback(() => setVerificationHash(null), []);

  const clearVerificationHashRef = useRef(clearVerificationHash);
  useEffect(() => { clearVerificationHashRef.current = clearVerificationHash; }, [clearVerificationHash]);

  // Stable callback ref so the IframeConnectionHandler closure always has the latest setter
  const enqueueAuthRequest = useCallback((request: AuthorizationRequest) => {
    setAuthQueue((prev) => {
      if (prev.some((r) => r.id === request.id)) return prev;
      return [...prev, request];
    });
  }, []);
  const enqueueAuthRef = useRef(enqueueAuthRequest);
  useEffect(() => { enqueueAuthRef.current = enqueueAuthRequest; }, [enqueueAuthRequest]);

  // Start the IframeConnectionHandler when the component mounts
  useEffect(() => {
    const config: IframeConnectionConfig = {
      walletId: "demo-web-wallet",
      walletName: "Aztec Demo Web Wallet",
      walletVersion: "0.1.0",
      // Empty allowedOrigins = all origins allowed (dev / prototype mode)
      allowedOrigins: [],
    };

    const handler = new IframeConnectionHandler(config, {
      onPendingDiscovery: (session) => {
        // Auto-approve discovery in prototype mode
        // TODO Phase 2: show an approval UI before approving
        handler.approveDiscovery(session.requestId);
      },
      onVerificationHash: (hash) => {
        setVerificationHash(hash);
      },
      getExternalWallet: async (appId, chainInfo) => {
        // First real wallet message arrived — emoji verification phase is over
        clearVerificationHashRef.current();
        // chainInfo arrives JSON-deserialized — chainId/version are hex strings
        // (Fr.toJSON() returns toString() = hex), not Fr instances. Reconstruct them.
        const rawChainId = (chainInfo as any).chainId;
        const rawVersion = (chainInfo as any).version;
        const chainId = rawChainId instanceof Fr ? rawChainId : Fr.fromString(String(rawChainId));
        const version = rawVersion instanceof Fr ? rawVersion : Fr.fromString(String(rawVersion));
        const { external } = await getOrCreateSession(
          { chainId, version },
          appId,
          (eventType, detail) => {
            if (eventType === "wallet-update") {
              // Forward to walletUpdateListeners so App.tsx's interactions list refreshes
              emitWalletUpdate(detail);
            } else if (eventType === "authorization-request") {
              // detail is a JSON string from AuthorizationRequestEvent
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
      {/* Base: full wallet UI, always rendered */}
      <App />
      {/* Overlay: emoji verification during key exchange */}
      <Dialog open={!!verificationHash} fullScreen>
        <EmojiVerification verificationHash={verificationHash ?? ""} />
      </Dialog>
      {/* Overlay: dApp authorization requests */}
      <Dialog open={!!currentAuth} fullScreen>
        {currentAuth && (
          <AuthorizationDialog
            request={currentAuth}
            queueLength={authQueue.length}
            onApprove={handleAuthApprove}
            onDeny={handleAuthDeny}
          />
        )}
      </Dialog>
    </WalletContext.Provider>
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

// main.tsx handles mounting based on iframe detection.
