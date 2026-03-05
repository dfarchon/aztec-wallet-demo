/**
 * Extended message types for iframe wallet communication.
 *
 * Re-exports WalletMessageType from the SDK and adds iframe-specific types
 * needed for postMessage transport (where MessagePort is unavailable).
 *
 * TODO: Upstream these to @aztec/wallet-sdk/types when iframe wallet support
 * is fully integrated into the SDK.
 */
import { WalletMessageType } from '@aztec/wallet-sdk/types';

export const IframeMessageType = {
  ...WalletMessageType,
  /** Wallet iframe ready signal (iframe announces it has loaded) */
  WALLET_READY: 'aztec-wallet-ready',
  /** Encrypted wallet message wrapper (for postMessage transport) */
  SECURE_MESSAGE: 'aztec-wallet-secure-message',
  /** Encrypted wallet response wrapper (for postMessage transport) */
  SECURE_RESPONSE: 'aztec-wallet-secure-response',
  /** Session disconnected notification */
  SESSION_DISCONNECTED: 'aztec-wallet-session-disconnected',
} as const;
