/**
 * StandaloneShell — full wallet UI when the web wallet is accessed directly
 * (not embedded as an iframe). Identical in look/feel to the Electron app.
 *
 * On first load, prompts the user to set a PIN for encrypting account secrets
 * in a cross-origin cookie. On subsequent loads, prompts for the existing PIN.
 */

import { useState, useCallback, useEffect } from "react";
import { Root } from "@demo-wallet/shared/ui";
import { WalletApi } from "./utils/wallet-api.ts";
import { PinDialog } from "./components/PinDialog.tsx";
import { hasAccountsCookie } from "../wallet/account-cookie.ts";
import { setCookiePassphrase } from "../wallet/wallet-service.ts";

export function StandaloneShell() {
  const [pinReady, setPinReady] = useState(false);
  const [pinMode, setPinMode] = useState<"set" | "enter">("set");
  const [pinError, setPinError] = useState<string | null>(null);

  useEffect(() => {
    setPinMode(hasAccountsCookie() ? "enter" : "set");
  }, []);

  const handlePinSubmit = useCallback(
    async (pin: string) => {
      setPinError(null);

      if (pinMode === "enter") {
        // Verify the PIN can decrypt the existing cookie
        const { readAccountsCookie } = await import(
          "../wallet/account-cookie.ts"
        );
        try {
          await readAccountsCookie(pin);
        } catch {
          setPinError("Wrong PIN. Please try again.");
          return;
        }
      }

      setCookiePassphrase(pin);
      setPinReady(true);
    },
    [pinMode],
  );

  if (!pinReady) {
    return (
      <PinDialog
        open
        mode={pinMode}
        error={pinError}
        onSubmit={handlePinSubmit}
      />
    );
  }

  return <Root walletApiFactory={WalletApi.create} />;
}
