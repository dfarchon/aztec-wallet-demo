import { type Account } from "@aztec/aztec.js/account";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import {
  type Aliased,
  type DeployAccountOptions,
  type SendOptions,
  type GrantedCapability,
  type ContractsCapability,
  type Capability,
} from "@aztec/aztec.js/wallet";
import { type Fr } from "@aztec/aztec.js/fields";
import {
  type AccountDeploymentStatus,
  type AccountType,
} from "../database/wallet-db";
import {
  WalletInteraction,
  WalletUpdateEvent,
  type WalletInteractionType,
} from "../types/wallet-interaction";

import {
  type ExecutionPayload,
  TxHash,
  TxSimulationResult,
} from "@aztec/stdlib/tx";
import type { DecodedExecutionTrace } from "../decoding/tx-callstack-decoder";
import { TxDecodingService } from "../decoding/tx-decoding-service";

import { BaseNativeWallet } from "./base-native-wallet.ts";
import {
  emptyOffchainOutput,
  NO_WAIT,
  toSendOptions,
  type InteractionWaitOptions,
  type SendReturn,
} from "@aztec/aztec.js/contracts";
import { waitForTx, type AztecNode } from "@aztec/aztec.js/node";
import { ProtocolContractAddress } from "@aztec/protocol-contracts";
import { computeFeePayerBalanceStorageSlot } from "@aztec/protocol-contracts/fee-juice";
import { getNetworkByChainId } from "../../config/networks";

// Enriched account type for internal use
export type InternalAccount = Aliased<AztecAddress> & {
  type: AccountType;
  deploymentStatus: AccountDeploymentStatus;
  deploymentError?: string;
  feeJuiceBalanceBaseUnits?: string | null;
};

async function getFeeJuiceBalanceBaseUnits(
  aztecNode: Pick<AztecNode, "getPublicStorageAt">,
  address: AztecAddress,
): Promise<string> {
  const slot = await computeFeePayerBalanceStorageSlot(address);
  const balance = await aztecNode.getPublicStorageAt(
    "latest",
    ProtocolContractAddress.FeeJuice,
    slot,
  );
  return balance.toBigInt().toString();
}

export function shouldUseSponsoredDeployment(networkId?: string): boolean {
  return networkId === "localhost";
}

export function buildDeployAccountOptions(
  networkId: string | undefined,
  paymentMethod?: NonNullable<DeployAccountOptions["fee"]>["paymentMethod"],
): DeployAccountOptions {
  const options: DeployAccountOptions = {
    from: AztecAddress.ZERO,
    skipClassPublication: true,
    skipInstancePublication: true,
  };

  if (shouldUseSponsoredDeployment(networkId)) {
    if (!paymentMethod) {
      throw new Error("Sponsored deployment requires a payment method");
    }
    options.fee = { paymentMethod };
  }

  return options;
}

/**
 * 1. Skips all authorization checks (trusted internal GUI)
 * 2. Returns enriched data (e.g., account types)
 * 3. Provides additional internal-only methods
 */
export class InternalWallet extends BaseNativeWallet {
  // Override getAccountFromAddress to skip authorization check
  protected override async getAccountFromAddress(
    address: AztecAddress,
  ): Promise<Account> {
    // Internal wallet is trusted, skip authorization and use base implementation
    return this.getAccountFromAddressInternal(address);
  }

  // Override getAccounts to return enriched data with account types
  override async getAccounts(): Promise<InternalAccount[]> {
    const accounts = await this.db.listAccounts();

    return Promise.all(
      accounts.map(async (acc) => {
        const [{ type }, deploymentState, feeJuiceBalanceBaseUnits] =
          await Promise.all([
          this.db.retrieveAccount(acc.item),
          this.db.getAccountDeploymentState(acc.item),
          getFeeJuiceBalanceBaseUnits(this.aztecNode, acc.item).catch(
            (error: unknown) => {
              const message =
                error instanceof Error ? error.message : String(error);
              this.log.warn(
                `Failed to load FeeJuice balance for ${acc.item.toString()}: ${message}`,
              );
              return null;
            },
          ),
        ]);
        return {
          ...acc,
          type,
          deploymentStatus: deploymentState.status,
          deploymentError: deploymentState.error,
          feeJuiceBalanceBaseUnits,
        };
      }),
    );
  }

  override async registerSender(
    address: AztecAddress,
    alias: string,
  ): Promise<AztecAddress> {
    // Store sender in database
    await this.db.storeSender(address, alias);
    // Register with PXE
    const result = await this.pxe.registerSender(address);
    // Emit wallet-update so the UI and cookie sync pick up the new contact
    const interaction = WalletInteraction.from({
      type: "registerSender",
      status: "SUCCESS",
      complete: true,
      title: `Registered contact ${alias}`,
    });
    await this.interactionManager.storeAndEmit(interaction);
    return result;
  }

  override async getAddressBook(): Promise<Aliased<AztecAddress>[]> {
    return this.getAddressBookInternal();
  }

  async createAccount(
    alias: string,
    type: AccountType,
    secret: Fr,
    salt: Fr,
    signingKey: Buffer,
  ): Promise<void> {
    const interaction = WalletInteraction.from({
      type: "createAccount",
      status: "CREATING",
      complete: false,
      title: `Creating account ${alias}`,
    });
    await this.interactionManager.storeAndEmit(interaction);

    try {
      const accountManager = await this.getAccountManager(
        type,
        secret,
        salt,
        signingKey,
      );
      await this.db.storeAccount(accountManager.address, {
        type,
        secretKey: secret,
        salt,
        alias,
        signingKey,
      });
      await this.db.storeAccountDeploymentState(accountManager.address, {
        status: "undeployed",
      });
      await this.interactionManager.storeAndEmit(
        interaction.update({
          status: "ACCOUNT CREATED",
          complete: true,
          description: `Address ${accountManager.address.toString()}`,
        }),
      );
    } catch (error: any) {
      await this.interactionManager.storeAndEmit(
        interaction.update({
          status: "ERROR",
          complete: true,
          description: `Failed: ${error.message || String(error)}`,
        }),
      );
      // Re-throw so the UI can also handle it
      throw error;
    }
  }

  async deployAccount(address: AztecAddress): Promise<void> {
    const interaction = WalletInteraction.from({
      type: "deployAccount",
      status: "PREPARING ACCOUNT",
      complete: false,
      title: `Deploying account ${address.toString()}`,
      description: `Address ${address.toString()}`,
    });
    await this.db.storeAccountDeploymentState(address, {
      status: "deploying",
    });
    await this.interactionManager.storeAndEmit(interaction);

    try {
      const { secretKey, salt, signingKey, type } =
        await this.db.retrieveAccount(address);
      const accountManager = await this.getAccountManager(
        type,
        secretKey,
        salt,
        signingKey,
      );
      const deployMethod = await accountManager.getDeployMethod();
      const network = getNetworkByChainId(
        this.chainInfo.chainId.toNumber(),
        this.chainInfo.version.toNumber(),
      );

      const paymentMethod = shouldUseSponsoredDeployment(network?.id)
        ? await import("../utils/sponsored-fpc.ts").then((module) =>
            module.prepareForFeePayment(this),
          )
        : undefined;
      const opts = buildDeployAccountOptions(network?.id, paymentMethod);

      const exec = await deployMethod.request({
        ...opts,
        deployer: AztecAddress.ZERO,
      });
      await this.sendTx(exec, await toSendOptions(opts), interaction);

      await this.db.storeAccountDeploymentState(address, {
        status: "deployed",
      });
      await this.interactionManager.storeAndEmit(
        interaction.update({ status: "DEPLOYED", complete: true }),
      );
    } catch (error: any) {
      const message = error.message || String(error);
      await this.db.storeAccountDeploymentState(address, {
        status: "undeployed",
        error: message,
      });
      await this.interactionManager.storeAndEmit(
        interaction.update({
          status: "ERROR",
          complete: true,
          description: `Failed: ${message}`,
        }),
      );
      throw error;
    }
  }

  override async sendTx<W extends InteractionWaitOptions = undefined>(
    executionPayload: ExecutionPayload,
    opts: SendOptions<W>,
    interaction?: WalletInteraction<WalletInteractionType>,
  ): Promise<SendReturn<W>> {
    const fee = await this.completeFeeOptions(
      opts.from,
      executionPayload.feePayer,
      opts.fee?.gasSettings,
    );
    const txRequest = await this.createTxExecutionRequestFromPayloadAndFee(
      executionPayload,
      opts.from,
      fee,
    );

    // Helper to format duration
    const formatDuration = (ms: number): string => {
      if (ms < 1000) return `${Math.round(ms)}ms`;
      return `${(ms / 1000).toFixed(1)}s`;
    };

    // Track proving time
    const provingStartTime = Date.now();
    await this.interactionManager.storeAndEmit(
      interaction.update({
        status: "PROVING",
      }),
    );
    const provenTx = await this.pxe.proveTx(
      txRequest,
      this.scopesFor(opts.from),
    );
    const provingTime = Date.now() - provingStartTime;

    const tx = await provenTx.toTx();
    const txHash = tx.getTxHash();
    if (await this.aztecNode.getTxEffect(txHash)) {
      throw new Error(
        `A settled tx with equal hash ${txHash.toString()} exists.`,
      );
    }

    // Track sending time
    const sendingStartTime = Date.now();
    await this.interactionManager.storeAndEmit(
      interaction.update({
        status: "SENDING",
      }),
    );
    this.log.debug(`Sending transaction ${txHash}`);
    await this.aztecNode.sendTx(tx).catch((err) => {
      throw this.contextualizeError(err, JSON.stringify(tx));
    });
    const sendingTime = Date.now() - sendingStartTime;
    this.log.info(`Sent transaction ${txHash}`);

    // If wait is NO_WAIT, return object with txHash and empty offchain output
    if (opts.wait === NO_WAIT) {
      const timingSummary = `Prove: ${formatDuration(provingTime)} | Send: ${formatDuration(sendingTime)}`;
      await this.interactionManager.storeAndEmit(
        interaction.update({ description: timingSummary }),
      );
      if (interaction) {
        const rawStats = provenTx.stats;
        await this.db.updateTxPayloadStats(interaction.id, {
          ...rawStats,
          timings: { ...rawStats.timings, sending: sendingTime },
        });
      }
      return {
        txHash,
        ...emptyOffchainOutput(),
      } as SendReturn<W>;
    }

    // Otherwise, return object with receipt and empty offchain output
    await this.interactionManager.storeAndEmit(interaction.update({ status: "MINING" }));
    const miningStartTime = Date.now();
    const waitOpts = typeof opts.wait === "object" ? opts.wait : undefined;
    const receipt = await waitForTx(this.aztecNode, txHash, waitOpts);
    const miningTime = Date.now() - miningStartTime;

    const timingSummary = `Prove: ${formatDuration(provingTime)} | Send: ${formatDuration(sendingTime)} | Mine: ${formatDuration(miningTime)}`;
    await this.interactionManager.storeAndEmit(
      interaction.update({ description: timingSummary }),
    );
    if (interaction) {
      const rawStats = provenTx.stats;
      await this.db.updateTxPayloadStats(interaction.id, {
        ...rawStats,
        timings: { ...rawStats.timings, sending: sendingTime, mining: miningTime },
      });
    }

    return {
      receipt,
      ...emptyOffchainOutput(),
    } as SendReturn<W>;
  }

  // Internal-only method: Delete account
  async deleteAccount(address: AztecAddress) {
    await this.db.deleteAccount(address);
  }

  // Internal-only: Get all interactions (unfiltered)
  getInteractions() {
    return this.db.listInteractions();
  }

  async getExecutionTrace(interactionId: string): Promise<
    | {
        trace?: DecodedExecutionTrace;
        stats?: any;
        from?: string;
        embeddedPaymentMethodFeePayer?: string;
      }
    | undefined
  > {
    // First check if it's a utility trace (simple trace)
    const utilityData = await this.db.getUtilityTrace(interactionId);
    if (utilityData) {
      return {
        trace: utilityData.trace as DecodedExecutionTrace,
        stats: utilityData.stats,
      };
    }

    // Otherwise, retrieve the stored simulation result (full tx)
    const data = await this.db.getTxPayloadData(interactionId);
    if (!data) {
      return undefined;
    }

    // Stats-only record (e.g. createAccount — no simulation was run)
    if (!data.simulationResult) {
      return {
        stats: data.metadata?.stats,
        from: data.metadata?.from,
      };
    }

    // Use the shared decoding cache from BaseNativeWallet
    const decodingService = new TxDecodingService(this.decodingCache, this.log);
    const parsedSimulationResult = TxSimulationResult.schema.parse(
      data.simulationResult,
    );

    const { executionTrace } = await decodingService.decodeTransaction(
      parsedSimulationResult,
    );
    // stats is already enriched at origin with simulation/sending/mining wall-clock times.
    // Fall back to simStats for simulate-only interactions.
    const stats = data.metadata?.stats ?? parsedSimulationResult.stats;

    return {
      trace: executionTrace,
      stats,
      from: data.metadata?.from,
      embeddedPaymentMethodFeePayer:
        data.metadata?.embeddedPaymentMethodFeePayer,
    };
  }

  // App authorization management methods
  async listAuthorizedApps(): Promise<string[]> {
    return await this.db.listAuthorizedApps();
  }

  async getAppCapabilities(
    appId: string,
  ): Promise<{ requested: GrantedCapability[]; granted: GrantedCapability[] }> {
    const [requested, granted] = await Promise.all([
      this.db.getRequestedCapabilities(appId),
      this.db.reconstructCapabilitiesFromKeys(appId),
    ]);
    return { requested, granted };
  }

  async resolveContractNames(
    addresses: string[],
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const addrStr of addresses) {
      result[addrStr] = await this.decodingCache.getAddressAlias(
        AztecAddress.fromString(addrStr),
      );
    }
    return result;
  }

  async capabilityToStorageKeys(
    capability: GrantedCapability,
  ): Promise<string[]> {
    return this.db.capabilityToStorageKeys(capability);
  }

  async storeCapabilityGrants(
    appId: string,
    granted: GrantedCapability[],
    requestedCapabilities?: GrantedCapability[],
  ): Promise<void> {
    await this.db.storeCapabilityGrants(appId, granted, requestedCapabilities);
    this.emitCapabilityChange();
  }

  async revokeCapability(
    appId: string,
    capability: GrantedCapability,
  ): Promise<void> {
    await this.db.revokeCapability(appId, capability);
    this.emitCapabilityChange();
  }

  async updateAccountAuthorization(
    appId: string,
    accounts: Aliased<AztecAddress>[],
  ): Promise<void> {
    await this.db.updateAccountAuthorization(appId, accounts);
    this.emitCapabilityChange();
  }

  async updateAddressBookAuthorization(
    appId: string,
    contacts: Aliased<AztecAddress>[],
  ): Promise<void> {
    await this.db.updateAddressBookAuthorization(appId, contacts);
    this.emitCapabilityChange();
  }

  async revokeAuthorization(key: string): Promise<void> {
    await this.db.revokeAuthorization(key);
    this.emitCapabilityChange();
  }

  async revokeAppAuthorizations(appId: string): Promise<void> {
    await this.db.revokeAppAuthorizations(appId);
    this.emitCapabilityChange();
  }

  /**
   * Emit a wallet-update event so cookie sync picks up capability changes
   * made through the Apps tab UI (storeCapabilityGrants, revoke, etc.).
   */
  private emitCapabilityChange(): void {
    const interaction = WalletInteraction.from({
      type: "capabilityChange" as any,
      status: "SUCCESS",
      complete: true,
      title: "Capability change",
    });
    this.interactionManager.dispatchEvent(
      new WalletUpdateEvent(interaction),
    );
  }
}
