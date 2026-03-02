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

import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { type ChainInfo } from "@aztec/aztec.js/account";
import { Fr } from "@aztec/aztec.js/fields";
import { createLogger } from "@aztec/aztec.js/log";
import { type PromiseWithResolvers } from "@aztec/foundation/promise";
import {
  ExternalWallet,
  InternalWallet,
  WalletDB,
  type AuthorizationRequest,
  type AuthorizationResponse,
  getNetworkByChainId,
} from "@demo-wallet/shared";
import {
  createPXE,
  getPXEConfig,
  type PXEConfig,
  type PXECreationOptions,
} from "@aztec/pxe/client/lazy";
import { createStore } from "@aztec/kv-store/indexeddb";

type SessionData = {
  sharedResources: Promise<{
    pxe: any;
    node: any;
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

      return { external: externalWallet, internal: internalWallet };
    };

    session.wallets.set(appId, walletInit());
  }

  return session.wallets.get(appId)!;
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
  pxe: any;
  node: any;
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
