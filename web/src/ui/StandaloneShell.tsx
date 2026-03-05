/**
 * StandaloneShell — full wallet UI when the web wallet is accessed directly
 * (not embedded as an iframe). Identical in look/feel to the Electron app.
 *
 * Wraps the App component with the same providers as the shared Root,
 * injecting the browser-specific WalletApi as the walletApiFactory.
 *
 * main.tsx handles mounting.
 */

import { Root } from "@demo-wallet/shared/ui";
import { WalletApi } from "./utils/wallet-api.ts";

export function StandaloneShell() {
  return <Root walletApiFactory={WalletApi.create} />;
}
