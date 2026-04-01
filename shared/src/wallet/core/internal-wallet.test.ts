import { describe, expect, it, vi } from "vitest";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import {
  buildDeployAccountOptions,
  InternalWallet,
} from "./internal-wallet";

describe("buildDeployAccountOptions", () => {
  it("uses sponsor payment method on localhost", () => {
    const paymentMethod = {} as any;

    expect(buildDeployAccountOptions("localhost", paymentMethod)).toMatchObject({
      from: AztecAddress.ZERO,
      fee: { paymentMethod },
      skipClassPublication: true,
      skipInstancePublication: true,
    });
  });

  it("omits sponsor payment method on testnet", () => {
    expect(buildDeployAccountOptions("testnet")).toMatchObject({
      from: AztecAddress.ZERO,
      skipClassPublication: true,
      skipInstancePublication: true,
    });
    expect(buildDeployAccountOptions("testnet").fee).toBeUndefined();
  });
});

describe("InternalWallet account onboarding", () => {
  it("getAccounts includes fee juice balances", async () => {
    const address = AztecAddress.fromBigInt(11n);
    const fakeWallet = {
      aztecNode: {
        getPublicStorageAt: vi.fn().mockResolvedValue({
          toBigInt: () => 1500000000000000000n,
        }),
      },
      db: {
        listAccounts: vi.fn().mockResolvedValue([
          { alias: "Account 11", item: address },
        ]),
        retrieveAccount: vi.fn().mockResolvedValue({
          type: "ecdsasecp256r1",
        }),
        getAccountDeploymentState: vi.fn().mockResolvedValue({
          status: "undeployed",
          error: undefined,
        }),
      },
      log: {
        warn: vi.fn(),
      },
    };

    const accounts = await InternalWallet.prototype.getAccounts.call(
      fakeWallet as any,
    );

    expect(accounts).toEqual([
      expect.objectContaining({
        alias: "Account 11",
        item: address,
        type: "ecdsasecp256r1",
        deploymentStatus: "undeployed",
        feeJuiceBalanceBaseUnits: "1500000000000000000",
      }),
    ]);
    expect(fakeWallet.log.warn).not.toHaveBeenCalled();
  });

  it("getAccounts tolerates fee juice lookup failures", async () => {
    const firstAddress = AztecAddress.fromBigInt(21n);
    const secondAddress = AztecAddress.fromBigInt(22n);
    const fakeWallet = {
      aztecNode: {
        getPublicStorageAt: vi
          .fn()
          .mockRejectedValueOnce(new Error("node unavailable"))
          .mockResolvedValueOnce({
            toBigInt: () => 42n,
          }),
      },
      db: {
        listAccounts: vi.fn().mockResolvedValue([
          { alias: "Account 21", item: firstAddress },
          { alias: "Account 22", item: secondAddress },
        ]),
        retrieveAccount: vi
          .fn()
          .mockResolvedValue({ type: "ecdsasecp256r1" }),
        getAccountDeploymentState: vi.fn().mockResolvedValue({
          status: "deployed",
          error: undefined,
        }),
      },
      log: {
        warn: vi.fn(),
      },
    };

    const accounts = await InternalWallet.prototype.getAccounts.call(
      fakeWallet as any,
    );

    expect(accounts).toEqual([
      expect.objectContaining({
        alias: "Account 21",
        item: firstAddress,
        feeJuiceBalanceBaseUnits: null,
      }),
      expect.objectContaining({
        alias: "Account 22",
        item: secondAddress,
        feeJuiceBalanceBaseUnits: "42",
      }),
    ]);
    expect(fakeWallet.log.warn).toHaveBeenCalledTimes(1);
  });

  it("createAccount stores undeployed account without deploying", async () => {
    const address = AztecAddress.fromBigInt(1n);
    const fakeWallet = {
      getAccountManager: vi.fn().mockResolvedValue({ address }),
      db: {
        storeAccount: vi.fn().mockResolvedValue(undefined),
        storeAccountDeploymentState: vi.fn().mockResolvedValue(undefined),
      },
      interactionManager: {
        storeAndEmit: vi.fn().mockResolvedValue(undefined),
      },
    };

    await InternalWallet.prototype.createAccount.call(
      fakeWallet as any,
      "Account 1",
      "ecdsasecp256r1",
      Fr.random(),
      Fr.random(),
      Buffer.alloc(32),
    );

    expect(fakeWallet.db.storeAccount).toHaveBeenCalledWith(
      address,
      expect.objectContaining({
        alias: "Account 1",
        type: "ecdsasecp256r1",
      }),
    );
    expect(fakeWallet.db.storeAccountDeploymentState).toHaveBeenCalledWith(
      address,
      { status: "undeployed" },
    );
    expect(fakeWallet.interactionManager.storeAndEmit).toHaveBeenCalledTimes(2);
    expect(
      fakeWallet.interactionManager.storeAndEmit.mock.calls[1][0].status,
    ).toBe("ACCOUNT CREATED");
  });

  it("deployAccount marks deployment success on testnet without sponsor", async () => {
    const address = AztecAddress.fromBigInt(2n);
    const request = vi.fn().mockResolvedValue({ feePayer: address });
    const fakeWallet = {
      chainInfo: {
        chainId: new Fr(11155111),
        version: new Fr(4127419662),
      },
      db: {
        retrieveAccount: vi.fn().mockResolvedValue({
          secretKey: Fr.random(),
          salt: Fr.random(),
          signingKey: Buffer.alloc(32),
          type: "ecdsasecp256r1",
        }),
        storeAccountDeploymentState: vi.fn().mockResolvedValue(undefined),
      },
      getAccountManager: vi.fn().mockResolvedValue({
        getDeployMethod: vi.fn().mockResolvedValue({ request }),
      }),
      sendTx: vi.fn().mockResolvedValue(undefined),
      interactionManager: {
        storeAndEmit: vi.fn().mockResolvedValue(undefined),
      },
    };

    await InternalWallet.prototype.deployAccount.call(fakeWallet as any, address);

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        from: AztecAddress.ZERO,
        deployer: AztecAddress.ZERO,
      }),
    );
    expect(request.mock.calls[0][0].fee).toBeUndefined();
    expect(fakeWallet.db.storeAccountDeploymentState).toHaveBeenNthCalledWith(
      1,
      address,
      { status: "deploying" },
    );
    expect(fakeWallet.db.storeAccountDeploymentState).toHaveBeenNthCalledWith(
      2,
      address,
      { status: "deployed" },
    );
  });

  it("deployAccount preserves the account on failure", async () => {
    const address = AztecAddress.fromBigInt(3n);
    const fakeWallet = {
      chainInfo: {
        chainId: new Fr(11155111),
        version: new Fr(4127419662),
      },
      db: {
        retrieveAccount: vi.fn().mockResolvedValue({
          secretKey: Fr.random(),
          salt: Fr.random(),
          signingKey: Buffer.alloc(32),
          type: "ecdsasecp256r1",
        }),
        storeAccountDeploymentState: vi.fn().mockResolvedValue(undefined),
      },
      getAccountManager: vi.fn().mockResolvedValue({
        getDeployMethod: vi.fn().mockResolvedValue({
          request: vi.fn().mockResolvedValue({ feePayer: address }),
        }),
      }),
      sendTx: vi.fn().mockRejectedValue(new Error("No fee juice")),
      interactionManager: {
        storeAndEmit: vi.fn().mockResolvedValue(undefined),
      },
    };

    await expect(
      InternalWallet.prototype.deployAccount.call(fakeWallet as any, address),
    ).rejects.toThrow("No fee juice");

    expect(fakeWallet.db.storeAccountDeploymentState).toHaveBeenNthCalledWith(
      1,
      address,
      { status: "deploying" },
    );
    expect(fakeWallet.db.storeAccountDeploymentState).toHaveBeenNthCalledWith(
      2,
      address,
      { status: "undeployed", error: "No fee juice" },
    );
  });
});
