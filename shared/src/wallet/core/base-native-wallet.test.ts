import { beforeEach, describe, expect, it, vi } from "vitest";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { GasFees } from "@aztec/stdlib/gas";
import { AccountFeePaymentMethodOptions } from "@aztec/entrypoints/account";
import { BaseNativeWallet } from "./base-native-wallet";
import { prepareForFeePayment } from "../utils/sponsored-fpc";

vi.mock("../utils/sponsored-fpc", () => ({
  prepareForFeePayment: vi.fn(),
}));

describe("BaseNativeWallet.completeFeeOptions", () => {
  const from = AztecAddress.fromBigInt(7n);
  const sponsoredPaymentMethod = { kind: "sponsored" } as any;

  beforeEach(() => {
    vi.mocked(prepareForFeePayment).mockReset();
  });

  it("uses sponsor by default on localhost", async () => {
    vi.mocked(prepareForFeePayment).mockResolvedValue(sponsoredPaymentMethod);
    const fakeWallet = {
      chainInfo: {
        chainId: new Fr(31337),
        version: new Fr(344372055),
      },
      minFeePadding: 0,
      aztecNode: {
        getCurrentMinFees: vi.fn().mockResolvedValue(new GasFees(10, 10)),
        getPublicStorageAt: vi.fn(),
      },
    };

    const result = await BaseNativeWallet.prototype.completeFeeOptions.call(
      fakeWallet as any,
      from,
    );

    expect(prepareForFeePayment).toHaveBeenCalledWith(fakeWallet);
    expect(fakeWallet.aztecNode.getPublicStorageAt).not.toHaveBeenCalled();
    expect(result.walletFeePaymentMethod).toBe(sponsoredPaymentMethod);
    expect(result.accountFeePaymentMethodOptions).toBe(
      AccountFeePaymentMethodOptions.EXTERNAL,
    );
  });

  it("uses sender fee juice by default on testnet", async () => {
    const fakeWallet = {
      chainInfo: {
        chainId: new Fr(11155111),
        version: new Fr(4127419662),
      },
      minFeePadding: 0,
      aztecNode: {
        getCurrentMinFees: vi.fn().mockResolvedValue(new GasFees(10, 10)),
        getPublicStorageAt: vi.fn().mockResolvedValue({
          toBigInt: () => 1n,
        }),
      },
    };

    const result = await BaseNativeWallet.prototype.completeFeeOptions.call(
      fakeWallet as any,
      from,
    );

    expect(prepareForFeePayment).not.toHaveBeenCalled();
    expect(fakeWallet.aztecNode.getPublicStorageAt).toHaveBeenCalledTimes(1);
    expect(result.walletFeePaymentMethod).toBeUndefined();
    expect(result.accountFeePaymentMethodOptions).toBe(
      AccountFeePaymentMethodOptions.PREEXISTING_FEE_JUICE,
    );
  });

  it("fails early when the sender has no fee juice on testnet", async () => {
    const fakeWallet = {
      chainInfo: {
        chainId: new Fr(11155111),
        version: new Fr(4127419662),
      },
      minFeePadding: 0,
      aztecNode: {
        getCurrentMinFees: vi.fn().mockResolvedValue(new GasFees(10, 10)),
        getPublicStorageAt: vi.fn().mockResolvedValue({
          toBigInt: () => 0n,
        }),
      },
    };

    await expect(
      BaseNativeWallet.prototype.completeFeeOptions.call(fakeWallet as any, from),
    ).rejects.toThrow(
      "Insufficient FeeJuice balance for sender on testnet; fund the account before sending",
    );

    expect(prepareForFeePayment).not.toHaveBeenCalled();
  });
});
