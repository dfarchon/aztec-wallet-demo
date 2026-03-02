/**
 * StandaloneShell — full wallet UI when the web wallet is accessed directly
 * (not embedded as an iframe). Identical in look/feel to the Electron app.
 *
 * Wraps the existing App component with the same providers as renderer.tsx.
 */

import { Root } from "./renderer.tsx";

// Root from renderer.tsx already includes ThemeProvider, NetworkProvider,
// WalletContext, and App. We just re-export it here for clarity.
// main.tsx handles mounting.

export function StandaloneShell() {
  return <Root />;
}
