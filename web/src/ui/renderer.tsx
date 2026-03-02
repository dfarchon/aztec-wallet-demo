/**
 * renderer.tsx — re-exports Root and WalletContext from @demo-wallet/shared.
 *
 * Root now takes a walletApiFactory prop so platform-specific wallet
 * implementations (browser vs Electron) can be injected without coupling.
 *
 * main.tsx is the entry point — it handles mounting based on iframe detection.
 */

export { Root, WalletContext } from "@demo-wallet/shared";
export { WalletApi } from "./utils/wallet-api.ts";
