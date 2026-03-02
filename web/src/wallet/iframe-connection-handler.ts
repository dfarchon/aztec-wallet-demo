/**
 * IframeConnectionHandler — wallet-side of the cross-origin iframe protocol.
 *
 * This mirrors BackgroundConnectionHandler from @aztec/wallet-sdk/extension/handlers
 * but uses window.postMessage instead of browser.runtime messaging.
 *
 * Message flow (wallet receives):
 *   parent → DISCOVERY_REQUEST  → show approval UI → send DISCOVERY_RESPONSE
 *   parent → KEY_EXCHANGE_REQUEST → ECDH → send KEY_EXCHANGE_RESPONSE
 *   parent → SECURE_MESSAGE (encrypted WalletMessage) → decrypt → ExternalWallet → encrypt → SECURE_RESPONSE
 *   parent → DISCONNECT_REQUEST → terminate session
 *
 * The wallet announces itself by posting WALLET_READY as soon as the handler starts,
 * so the dApp knows it can send a discovery request.
 */

import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSessionKeys,
  encrypt,
  decrypt,
  type EncryptedPayload,
} from "@aztec/wallet-sdk/crypto";
import {
  type WalletMessage,
  type WalletResponse,
  WalletMessageType,
} from "@aztec/wallet-sdk/types";
import { WalletSchema } from "@aztec/aztec.js/wallet";
import { parseWithOptionals, schemaHasMethod } from "@aztec/foundation/schemas";
import { jsonStringify } from "@aztec/foundation/json-rpc";
import { createLogger } from "@aztec/aztec.js/log";
import type { ExternalWallet } from "@demo-wallet/shared";

// ─── Internal message types (mirrors extension's internal_message_types.ts) ───

export const IframeMessageType = {
  // dApp → wallet
  DISCOVERY_REQUEST: "iframe-discovery-request",
  KEY_EXCHANGE_REQUEST: "iframe-key-exchange-request",
  DISCONNECT_REQUEST: "iframe-disconnect-request",
  SECURE_MESSAGE: "iframe-secure-message",
  // wallet → dApp
  WALLET_READY: "iframe-wallet-ready",
  DISCOVERY_RESPONSE: "iframe-discovery-response",
  KEY_EXCHANGE_RESPONSE: "iframe-key-exchange-response",
  SECURE_RESPONSE: "iframe-secure-response",
  SESSION_DISCONNECTED: "iframe-session-disconnected",
} as const;

interface PendingSession {
  requestId: string;
  appId: string;
  origin: string;
  status: "pending" | "approved";
}

interface ActiveSession {
  sessionId: string;
  sharedKey: CryptoKey;
  verificationHash: string;
  origin: string;
  appId: string;
}

export interface IframeConnectionConfig {
  walletId: string;
  walletName: string;
  walletVersion: string;
  walletIcon?: string;
  /** Origins allowed to connect. If empty, all origins are allowed (dev mode). */
  allowedOrigins?: string[];
}

export interface IframeConnectionCallbacks {
  /** Called when a new discovery request arrives — wallet can show approval UI */
  onPendingDiscovery?: (session: PendingSession) => void;
  /** Called when a session is established (key exchange complete) — verificationHash for emoji display */
  onSessionEstablished?: (session: ActiveSession) => void;
  /** Called when a session is terminated */
  onSessionTerminated?: (sessionId: string) => void;
  /** Called when a key exchange completes — show verificationHash as emojis to the user */
  onVerificationHash?: (verificationHash: string) => void;
  /**
   * Resolves the ExternalWallet to use for a given chainInfo.
   * Called when an encrypted message arrives and needs to be dispatched.
   */
  getExternalWallet: (appId: string, chainInfo: { chainId: string; version: string }) => Promise<ExternalWallet>;
}

export class IframeConnectionHandler {
  private pendingSessions = new Map<string, PendingSession>();
  private activeSessions = new Map<string, ActiveSession>();
  private log = createLogger("wallet:iframe-handler");

  constructor(
    private config: IframeConnectionConfig,
    private callbacks: IframeConnectionCallbacks,
  ) {}

  start(): void {
    window.addEventListener("message", this.handleMessage);
    // Announce readiness to any already-loaded parent frame
    this.postToParent({ type: IframeMessageType.WALLET_READY });
    this.log.info("IframeConnectionHandler started, posted WALLET_READY");
  }

  stop(): void {
    window.removeEventListener("message", this.handleMessage);
  }

  // ─── Approval API (called by wallet UI) ────────────────────────────────────

  approveDiscovery(requestId: string): void {
    const pending = this.pendingSessions.get(requestId);
    if (!pending || pending.status !== "pending") return;

    pending.status = "approved";
    this.postToOrigin(pending.origin, {
      type: IframeMessageType.DISCOVERY_RESPONSE,
      requestId,
      walletInfo: {
        id: this.config.walletId,
        name: this.config.walletName,
        version: this.config.walletVersion,
        icon: this.config.walletIcon,
      },
    });
    this.log.info(`Discovery approved for requestId=${requestId}`);
  }

  rejectDiscovery(requestId: string): void {
    this.pendingSessions.delete(requestId);
  }

  // ─── Message handler ────────────────────────────────────────────────────────

  private handleMessage = async (event: MessageEvent): Promise<void> => {
    // Origin check
    if (this.config.allowedOrigins && this.config.allowedOrigins.length > 0) {
      if (!this.config.allowedOrigins.includes(event.origin)) {
        return;
      }
    }

    const msg = event.data;
    if (!msg || typeof msg !== "object" || !msg.type) return;

    switch (msg.type) {
      case IframeMessageType.DISCOVERY_REQUEST:
        this.handleDiscoveryRequest(msg, event.origin);
        break;
      case IframeMessageType.KEY_EXCHANGE_REQUEST:
        await this.handleKeyExchangeRequest(msg, event.origin);
        break;
      case IframeMessageType.SECURE_MESSAGE:
        await this.handleSecureMessage(msg);
        break;
      case IframeMessageType.DISCONNECT_REQUEST:
        this.terminateSession(msg.sessionId);
        break;
    }
  };

  private handleDiscoveryRequest(msg: any, origin: string): void {
    const { requestId, appId } = msg;
    const pending: PendingSession = { requestId, appId, origin, status: "pending" };
    this.pendingSessions.set(requestId, pending);
    this.log.info(`Discovery request from appId=${appId} origin=${origin}`);
    this.callbacks.onPendingDiscovery?.(pending);
  }

  private async handleKeyExchangeRequest(msg: any, origin: string): Promise<void> {
    const { requestId, publicKey: appPublicKeyRaw } = msg;
    const pending = this.pendingSessions.get(requestId);
    if (!pending || pending.status !== "approved") {
      this.log.warn(`Key exchange for unknown/unapproved requestId=${requestId}`);
      return;
    }

    try {
      const keyPair = await generateKeyPair();
      const walletPublicKey = await exportPublicKey(keyPair.publicKey);
      const appPublicKey = await importPublicKey(appPublicKeyRaw);
      const sessionKeys = await deriveSessionKeys(keyPair, appPublicKey, false);

      const session: ActiveSession = {
        sessionId: requestId,
        sharedKey: sessionKeys.encryptionKey,
        verificationHash: sessionKeys.verificationHash,
        origin: pending.origin,
        appId: pending.appId,
      };

      this.activeSessions.set(requestId, session);
      this.pendingSessions.delete(requestId);

      this.postToOrigin(origin, {
        type: IframeMessageType.KEY_EXCHANGE_RESPONSE,
        requestId,
        publicKey: walletPublicKey,
        verificationHash: sessionKeys.verificationHash,
      });

      this.callbacks.onVerificationHash?.(sessionKeys.verificationHash);
      this.callbacks.onSessionEstablished?.(session);
      this.log.info(`Key exchange complete, sessionId=${requestId}`);
    } catch (err) {
      this.log.error(`Key exchange failed: ${err}`);
    }
  }

  private async handleSecureMessage(msg: any): Promise<void> {
    const { sessionId, encrypted } = msg;
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    let walletMessage: WalletMessage;
    try {
      walletMessage = await decrypt<WalletMessage>(session.sharedKey, encrypted as EncryptedPayload);
    } catch {
      this.log.warn(`Decryption failed for sessionId=${sessionId}`);
      return;
    }

    const { messageId, type, args, chainInfo, appId } = walletMessage;

    let result: unknown;
    let error: string | undefined;

    try {
      const externalWallet = await this.callbacks.getExternalWallet(appId, chainInfo as any);

      if (!schemaHasMethod(WalletSchema, type)) {
        throw new Error(`Unknown wallet method: ${type}`);
      }
      const sanitizedArgs = await parseWithOptionals(args, WalletSchema[type as keyof typeof WalletSchema].parameters());
      result = await (externalWallet as any)[type](...sanitizedArgs);
    } catch (err: any) {
      error = err instanceof Error ? err.message : String(err);
      this.log.error(`Error handling ${type}: ${error}`);
    }

    const response: WalletResponse = {
      messageId,
      walletId: this.config.walletId,
      result,
      error,
    };

    try {
      const encryptedResponse = await encrypt(session.sharedKey, jsonStringify(response));
      this.postToOrigin(session.origin, {
        type: IframeMessageType.SECURE_RESPONSE,
        sessionId,
        encrypted: encryptedResponse,
      });
    } catch (err) {
      this.log.error(`Encryption of response failed: ${err}`);
    }
  }

  terminateSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      this.postToOrigin(session.origin, {
        type: IframeMessageType.SESSION_DISCONNECTED,
        sessionId,
      });
      this.activeSessions.delete(sessionId);
      this.callbacks.onSessionTerminated?.(sessionId);
    }
  }

  getPendingSessions(): PendingSession[] {
    return Array.from(this.pendingSessions.values()).filter(s => s.status === "pending");
  }

  // ─── Transport helpers ──────────────────────────────────────────────────────

  /** Post to the parent frame (works whether embedded as iframe or opened as popup) */
  private postToParent(msg: object): void {
    if (window.parent !== window) {
      window.parent.postMessage(msg, "*");
    }
  }

  /** Post to a specific origin's parent frame */
  private postToOrigin(origin: string, msg: object): void {
    if (window.parent !== window) {
      window.parent.postMessage(msg, origin);
    }
  }
}
