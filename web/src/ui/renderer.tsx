import { StrictMode, createContext, useMemo } from "react";
import "./index.css";
import {
  createTheme,
  CssBaseline,
  type ThemeOptions,
  ThemeProvider,
} from "@mui/material";
import { colors } from "./styles.ts";
import { App } from "./App.tsx";
import { WalletApi } from "./utils/wallet-api.ts";
import type { InternalWalletInterface } from "../ipc/wallet-internal-interface.ts";
import { NetworkProvider, useNetwork } from "./contexts/NetworkContext.tsx";
import { networkToChainInfo } from "../config/networks.ts";

const themeOptions: ThemeOptions = {
  palette: {
    mode: "dark",
    primary: {
      main: colors.primary,
    },
    secondary: {
      main: colors.secondary,
    },
  },
  typography: {
    fontFamily: "monospace",
    subtitle2: {
      color: "darkgrey",
    },
  },
};

const theme = createTheme(themeOptions);

export const WalletContext = createContext<{
  walletAPI: InternalWalletInterface;
}>({ walletAPI: null! });

function WalletProviderWrapper() {
  const { currentNetwork } = useNetwork();
  const chainInfo = networkToChainInfo(currentNetwork);

  // Create wallet API with current network's chain info
  const walletAPI = useMemo(
    () => WalletApi.create(chainInfo.chainId, chainInfo.version),
    [currentNetwork.id], // Recreate when network changes
  );

  const walletContext = useMemo(() => ({ walletAPI }), [walletAPI]);

  return (
    <WalletContext.Provider value={walletContext}>
      <CssBaseline />
      <App />
    </WalletContext.Provider>
  );
}

export function Root() {
  return (
    <StrictMode>
      <ThemeProvider theme={theme}>
        <NetworkProvider>
          <WalletProviderWrapper />
        </NetworkProvider>
      </ThemeProvider>
    </StrictMode>
  );
}

// main.tsx is the entry point — it handles mounting based on iframe detection.
