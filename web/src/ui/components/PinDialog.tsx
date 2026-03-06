/**
 * PIN dialog — prompts the user for a short passphrase (PIN) used to
 * encrypt/decrypt account secrets stored in the cross-origin cookie.
 *
 * Two modes:
 * - "set": User sets a new PIN (standalone wallet, first time)
 * - "enter": User enters existing PIN (iframe, or standalone after reload)
 */

import { useState, useCallback } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Typography,
} from "@mui/material";

export interface PinDialogProps {
  open: boolean;
  mode: "set" | "enter";
  error?: string | null;
  onSubmit: (pin: string) => void;
}

export function PinDialog({ open, mode, error, onSubmit }: PinDialogProps) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = useCallback(() => {
    if (pin.length < 6) {
      setLocalError("PIN must be at least 6 characters");
      return;
    }
    if (mode === "set" && pin !== confirm) {
      setLocalError("PINs do not match");
      return;
    }
    setLocalError(null);
    onSubmit(pin);
  }, [pin, confirm, mode, onSubmit]);

  const displayError = error ?? localError;

  return (
    <Dialog open={open} maxWidth="xs" fullWidth>
      <DialogTitle>
        {mode === "set" ? "Set wallet PIN" : "Enter wallet PIN"}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {mode === "set"
            ? "This PIN encrypts your account secrets for cross-origin access. You'll need it when using the wallet from a dApp."
            : "Enter your PIN to decrypt your wallet accounts."}
        </Typography>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <TextField
            autoFocus
            label="PIN"
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (mode === "set" && !confirm) return;
                handleSubmit();
              }
            }}
            inputProps={{ minLength: 6, maxLength: 32 }}
            fullWidth
            size="small"
          />
          {mode === "set" && (
            <TextField
              label="Confirm PIN"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
              }}
              inputProps={{ minLength: 6, maxLength: 32 }}
              fullWidth
              size="small"
            />
          )}
          {displayError && (
            <Typography variant="body2" color="error">
              {displayError}
            </Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleSubmit} variant="contained" disabled={pin.length < 6}>
          {mode === "set" ? "Set PIN" : "Unlock"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
