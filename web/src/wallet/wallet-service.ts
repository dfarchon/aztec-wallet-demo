/**
 * Browser wallet service — the browser equivalent of wallet-worker.ts.
 *
 * Manages PXE sessions indexed by `chainId-version`. Each session has one
 * shared PXE instance (critical: multiple PXE instances sharing the same
 * IndexedDB store cause Map/storage desync) plus per-appId wallet pairs.
 *
 * Key differences from Electron wallet-worker.ts:
 * - Uses @aztec/pxe/client/lazy (WASM prover, lazy artifact loading)
 * - Uses @aztec/kv-store IndexedDB backend instead of LMDB
 * - Runs in the main browser thread (no worker thread / MessagePortMain)
 * - Logger uses createLogger directly (no proxy logger needed)
 */

import { createAztecNodeClient, type AztecNode } from "@aztec/aztec.js/node";
import { type ChainInfo } from "@aztec/aztec.js/account";
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createLogger } from "@aztec/aztec.js/log";
import { type PromiseWithResolvers } from "@aztec/foundation/promise";
import {
  ExternalWallet,
  InternalWallet,
  WalletDB,
  type AuthorizationRequest,
  type AuthorizationResponse,
  getNetworkByChainId,
} from "@demo-wallet/shared/core";
import {
  createPXE,
  getPXEConfig,
  type PXE,
  type PXEConfig,
  type PXECreationOptions,
} from "@aztec/pxe/client/lazy";
import { createStore } from "@aztec/kv-store/indexeddb";
import {
  writeAccountsCookie,
  readAccountsCookie,
  writeContactsCookies,
  readContactsCookies,
  writeCapabilitiesCookies,
  readCapabilitiesCookies,
  type PortableAccount,
  type PortableContact,
} from "./sync-cookies.ts";

const IS_IFRAME = typeof window !== "undefined" && window.self !== window.top;

type SessionData = {
  sharedResources: Promise<{
    pxe: PXE;
    node: AztecNode;
    db: WalletDB;
    pendingAuthorizations: Map<
      string,
      {
        promise: PromiseWithResolvers<AuthorizationResponse>;
        request: AuthorizationRequest;
      }
    >;
  }>;
  wallets: Map<
    string,
    Promise<{ external: ExternalWallet; internal: InternalWallet }>
  >;
};

const RUNNING_SESSIONS = new Map<string, SessionData>();

// ─── Debounced cookie sync ───
// A single timer across all wallet-update events. Prevents redundant PBKDF2
// derivations when multiple events fire in quick succession.
let _cookieSyncTimer: ReturnType<typeof setTimeout> | null = null;
let _cookieSyncDb: WalletDB | null = null;

function scheduleCookieSync(db: WalletDB): void {
  _cookieSyncDb = db;
  if (_cookieSyncTimer) return; // already scheduled
  _cookieSyncTimer = setTimeout(async () => {
    _cookieSyncTimer = null;
    if (_cookieSyncDb && _cookiePassphrase) {
      // Accounts and contacts are standalone-only (source of truth).
      if (!IS_IFRAME) {
        await syncAccountsToCookie(_cookieSyncDb);
        await syncContactsToCookie(_cookieSyncDb);
      }
      // Capabilities sync bidirectionally — grants made in the iframe
      // (via requestCapabilities from the dApp) must propagate back to
      // the standalone wallet's Authorized Apps view.
      await syncCapabilitiesToCookie(_cookieSyncDb);
    }
  }, 500);
}

// ─── Passphrase management ───
// Held in memory only — never persisted. Must be set before cookie operations.
let _cookiePassphrase: string | null = null;

/** Set the passphrase used to encrypt/decrypt the accounts cookie. */
export function setCookiePassphrase(passphrase: string): void {
  _cookiePassphrase = passphrase;
}

/** Returns whether a cookie passphrase has been set for this session. */
export function hasCookiePassphrase(): boolean {
  return _cookiePassphrase !== null;
}

export async function getOrCreateSession(
  chainInfo: ChainInfo,
  appId: string,
  onWalletEvent: (eventType: string, detail: unknown) => void,
): Promise<{ external: ExternalWallet; internal: InternalWallet }> {
  const network = getNetworkByChainId(
    chainInfo.chainId.toNumber(),
    chainInfo.version.toNumber(),
  );
  if (!network) {
    throw new Error(
      `Unknown network: chainId=${chainInfo.chainId.toNumber()}, version=${chainInfo.version.toNumber()}`,
    );
  }

  const node = createAztecNodeClient(network.nodeUrl!);

  // Auto-detect version if 0
  if (chainInfo.version.equals(new Fr(0))) {
    const { rollupVersion } = await node.getNodeInfo();
    chainInfo = { ...chainInfo, version: new Fr(rollupVersion) };
  }

  const sessionId = `${chainInfo.chainId.toNumber()}-${chainInfo.version.toNumber()}`;
  let session = RUNNING_SESSIONS.get(sessionId);

  if (!session) {
    const log = createLogger("wallet:session");
    log.info(
      `[PXE-INIT] Creating NEW session with shared PXE instance for sessionId=${sessionId}`,
    );

    const pxeInit = (async () => {
      const l1Contracts = await node.getL1ContractAddresses();
      const rollupAddress = l1Contracts.rollupAddress;

      const configOverrides: Partial<PXEConfig> = {
        dataDirectory: `./pxe-${rollupAddress}`,
        proverEnabled: true,
      };

      const options: PXECreationOptions = {
        loggers: {
          store: createLogger("pxe:data:lmdb"),
          pxe: createLogger("pxe:service"),
          prover: createLogger("bb:native"),
        },
        store: await createStore(
          `pxe-${rollupAddress}`,
          {
            dataDirectory: configOverrides.dataDirectory,
            dataStoreMapSizeKb: 2e10,
          },
          2,
          createLogger("pxe:data:lmdb"),
        ),
      };

      const walletDBLogger = createLogger("wallet:data:lmdb");
      const walletDBStore = await createStore(
        `wallet-${rollupAddress}`,
        {
          dataDirectory: `wallet-${rollupAddress}`,
          dataStoreMapSizeKb: 2e10,
        },
        2,
        walletDBLogger,
      );
      const db = WalletDB.init(walletDBStore, walletDBLogger);

      const pxe = await createPXE(
        node,
        { ...getPXEConfig(), ...configOverrides },
        options,
      );

      const pendingAuthorizations = new Map<
        string,
        {
          promise: PromiseWithResolvers<AuthorizationResponse>;
          request: AuthorizationRequest;
        }
      >();

      if (_cookiePassphrase) {
        // Capabilities sync bidirectionally: import from cookies first so
        // grants made in the iframe are merged into WalletDB, then export
        // the combined state back.
        await bootstrapCapabilitiesFromCookie(db);

        if (!IS_IFRAME) {
          // Accounts and contacts are standalone-only (source of truth).
          await syncAccountsToCookie(db);
          await syncContactsToCookie(db);
        }
        // Re-export the merged capabilities (includes both local + cookie grants).
        await syncCapabilitiesToCookie(db);
      }

      return { pxe, node, db, pendingAuthorizations };
    })();

    session = { sharedResources: pxeInit, wallets: new Map() };
    RUNNING_SESSIONS.set(sessionId, session);
  } else {
    createLogger("wallet:session").info(
      `[PXE-INIT] Reusing existing shared PXE instance for sessionId=${sessionId}`,
    );
  }

  const sharedResources = await session.sharedResources;

  if (!session.wallets.has(appId)) {
    const walletInit = async () => {
      const externalLog = createLogger(`wallet:external:${appId}`);
      const internalLog = createLogger(`wallet:internal:${appId}`);

      const externalWallet = new ExternalWallet(
        sharedResources.pxe,
        sharedResources.node,
        sharedResources.db,
        sharedResources.pendingAuthorizations,
        appId,
        chainInfo,
        externalLog,
      );

      const internalWallet = new InternalWallet(
        sharedResources.pxe,
        sharedResources.node,
        sharedResources.db,
        sharedResources.pendingAuthorizations,
        appId,
        chainInfo,
        internalLog,
      );

      const wireEvents = (wallet: ExternalWallet | InternalWallet) => {
        wallet.addEventListener("wallet-update", (event: Event) => {
          onWalletEvent("wallet-update", (event as CustomEvent).detail);
          scheduleCookieSync(sharedResources.db);
        });
        wallet.addEventListener("authorization-request", (event: Event) => {
          onWalletEvent("authorization-request", (event as CustomEvent).detail);
        });
        wallet.addEventListener(
          "proof-debug-export-request",
          (event: Event) => {
            onWalletEvent(
              "proof-debug-export-request",
              (event as CustomEvent).detail,
            );
          },
        );
      };

      wireEvents(externalWallet);
      wireEvents(internalWallet);

      // In iframe mode, bootstrap accounts and contacts from cookies into PXE.
      // (Capabilities are bootstrapped at PXE init for both modes.)
      if (IS_IFRAME && _cookiePassphrase) {
        await bootstrapAccountsFromCookie(chainInfo, internalWallet);
        await bootstrapContactsFromCookie(sharedResources.db, sharedResources.pxe);
      }

      return { external: externalWallet, internal: internalWallet };
    };

    session.wallets.set(appId, walletInit());
  }

  return session.wallets.get(appId)!;
}

/**
 * Import accounts from the encrypted cookie into the session's WalletDB
 * and register them with PXE (via InternalWallet.getAccountManager).
 * Used by the iframe to bootstrap accounts from the standalone wallet.
 * Requires passphrase to have been set via setCookiePassphrase().
 * Skips accounts that already exist in the DB.
 *
 * @param wallet - An InternalWallet instance used to register accounts with PXE.
 */
export async function bootstrapAccountsFromCookie(
  chainInfo: ChainInfo,
  wallet: InternalWallet,
): Promise<number> {
  const log = createLogger("wallet:cookie");

  if (!_cookiePassphrase) {
    log.warn("No passphrase set — cannot read encrypted cookie");
    return 0;
  }

  const portableAccounts = await readAccountsCookie(_cookiePassphrase);

  if (portableAccounts.length === 0) {
    log.info("No accounts found in cookie");
    return 0;
  }

  const { db } = await getSharedResources(chainInfo);
  const existingAccounts = await db.listAccounts();
  const existingAddresses = new Set(
    existingAccounts.map((a) => a.item.toString()),
  );

  let imported = 0;
  for (const portable of portableAccounts) {
    const secretKey = Fr.fromString(portable.secretKey);
    const salt = Fr.fromString(portable.salt);
    const signingKey = Buffer.from(portable.signingKey, "hex");

    if (!existingAddresses.has(portable.address)) {
      const address = AztecAddress.fromString(portable.address);
      await db.storeAccount(address, {
        type: portable.type,
        secretKey,
        salt,
        signingKey,
        alias: portable.alias,
      });
      imported++;
      log.info(
        `Imported account ${portable.alias ?? portable.address} from cookie`,
      );
    }

    // Register with PXE via the wallet's getAccountManager (idempotent).
    // Yield to a new macro-task between registrations so IndexedDB transactions
    // from the previous iteration fully commit (the kv-store's transactionAsync
    // sets a shared #_db on all map containers, which can collide with
    // standalone writes like addContractInstance if they overlap).
    await new Promise(resolve => setTimeout(resolve, 0));
    await wallet.getAccountManager(portable.type, secretKey, salt, signingKey);
    log.info(
      `Registered account ${portable.alias ?? portable.address} with PXE`,
    );
  }

  log.info(
    `Bootstrapped ${imported} new account(s) from cookie (${portableAccounts.length} total in cookie)`,
  );
  return imported;
}

/**
 * Import contacts from the encrypted cookies into the session's WalletDB
 * and register them as senders with PXE.
 * Bypasses InternalWallet.registerSender to avoid emitting interaction events
 * for each bootstrapped contact (which would clutter the interaction history).
 */
async function bootstrapContactsFromCookie(
  db: WalletDB,
  pxe: PXE,
): Promise<number> {
  const log = createLogger("wallet:cookie");

  if (!_cookiePassphrase) {
    log.warn("No passphrase set — cannot read contacts cookies");
    return 0;
  }

  const portableContacts = await readContactsCookies(_cookiePassphrase);
  if (portableContacts.length === 0) {
    log.info("No contacts found in cookies");
    return 0;
  }

  let imported = 0;
  for (const contact of portableContacts) {
    const address = AztecAddress.fromBuffer(Buffer.from(contact.address));
    // Yield to a new macro-task so the previous iteration's IndexedDB
    // transaction fully commits (same issue as account bootstrap).
    await new Promise(resolve => setTimeout(resolve, 0));
    await db.storeSender(address, contact.alias);
    await pxe.registerSender(address);
    imported++;
  }

  log.info(`Bootstrapped ${imported} contact(s) from cookies`);
  return imported;
}

/**
 * Read all accounts from WalletDB and write them to the encrypted cookie.
 * Called after PXE init and on wallet-update events to keep the cookie in sync.
 * No-op if passphrase is not set.
 */
async function syncAccountsToCookie(db: WalletDB): Promise<void> {
  if (!_cookiePassphrase) return;

  try {
    const aliasedAccounts = await db.listAccounts();
    const portableAccounts: PortableAccount[] = [];

    for (const { alias, item: address } of aliasedAccounts) {
      const account = await db.retrieveAccount(address);
      portableAccounts.push({
        address: address.toString(),
        secretKey: account.secretKey.toString(),
        salt: account.salt.toString(),
        signingKey: Buffer.from(account.signingKey).toString("hex"),
        type: account.type,
        alias,
      });
    }

    await writeAccountsCookie(portableAccounts, _cookiePassphrase);
    createLogger("wallet:cookie").info(
      `Synced ${portableAccounts.length} account(s) to encrypted cookie`,
    );
  } catch (e) {
    createLogger("wallet:cookie").warn(
      `Failed to sync accounts to cookie: ${e}`,
    );
  }
}

/**
 * Read all contacts (senders) from WalletDB and write them to encrypted cookies.
 * Called alongside syncAccountsToCookie. No-op if passphrase is not set.
 */
async function syncContactsToCookie(db: WalletDB): Promise<void> {
  if (!_cookiePassphrase) return;

  try {
    const senders = await db.listSenders();
    const portableContacts: PortableContact[] = senders.map(({ alias, item: address }) => ({
      address: address.toBuffer(),
      alias: alias.replace(/^senders:/, ""),
    }));

    await writeContactsCookies(portableContacts, _cookiePassphrase);
    createLogger("wallet:cookie").info(
      `Synced ${portableContacts.length} contact(s) to encrypted cookies`,
    );
  } catch (e) {
    createLogger("wallet:cookie").warn(
      `Failed to sync contacts to cookie: ${e}`,
    );
  }
}

/**
 * Export all capability grants from WalletDB and write them to encrypted cookies.
 * Called alongside syncAccountsToCookie/syncContactsToCookie.
 * Standalone mode only — iframe never writes capabilities cookies.
 */
async function syncCapabilitiesToCookie(db: WalletDB): Promise<void> {
  if (!_cookiePassphrase) return;

  try {
    const apps = await db.exportAllAuthorizations();
    await writeCapabilitiesCookies(apps, _cookiePassphrase);
    createLogger("wallet:cookie").info(
      `Synced capabilities for ${apps.length} app(s) to encrypted cookies`,
    );
  } catch (e) {
    createLogger("wallet:cookie").warn(
      `Failed to sync capabilities to cookie: ${e}`,
    );
  }
}

/**
 * Import capability grants from the encrypted cookies into the session's WalletDB.
 * Used by the iframe to bootstrap dApp authorization state from the standalone wallet.
 */
async function bootstrapCapabilitiesFromCookie(db: WalletDB): Promise<number> {
  const log = createLogger("wallet:cookie");

  if (!_cookiePassphrase) {
    log.warn("No passphrase set — cannot read capabilities cookies");
    return 0;
  }

  const apps = await readCapabilitiesCookies(_cookiePassphrase);
  if (apps.length === 0) {
    log.info("No capabilities found in cookies");
    return 0;
  }

  const imported = await db.importAllAuthorizations(apps);
  log.info(
    `Bootstrapped capabilities for ${apps.length} app(s) (${imported} entries) from cookies`,
  );
  return imported;
}

/** Returns the current sessions map (for debugging / UI inspection) */
export function getRunningSessionIds(): string[] {
  return Array.from(RUNNING_SESSIONS.keys());
}

/**
 * Returns the shared resources for a session (pxe, node, db, pendingAuthorizations).
 * Used by the UI wallet-api to resolve authorization requests directly.
 */
export async function getSharedResources(chainInfo: ChainInfo): Promise<{
  pxe: PXE;
  node: AztecNode;
  db: WalletDB;
  pendingAuthorizations: Map<
    string,
    {
      promise: PromiseWithResolvers<AuthorizationResponse>;
      request: AuthorizationRequest;
    }
  >;
}> {
  const sessionId = `${chainInfo.chainId.toNumber()}-${chainInfo.version.toNumber()}`;
  const session = RUNNING_SESSIONS.get(sessionId);
  if (!session) {
    throw new Error(`No session found for sessionId=${sessionId}`);
  }
  return session.sharedResources;
}
