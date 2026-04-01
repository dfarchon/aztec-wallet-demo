import { describe, expect, it } from "vitest";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { AccountFeePaymentMethodOptions } from "@aztec/entrypoints/account";
import { resolveFeeStrategy } from "./fee-strategy";

describe("resolveFeeStrategy", () => {
  const from = AztecAddress.fromBigInt(1n);

  it("uses sponsor by default on localhost", () => {
    expect(resolveFeeStrategy("localhost", from)).toEqual({
      useSponsoredPaymentMethod: true,
      accountFeePaymentMethodOptions: AccountFeePaymentMethodOptions.EXTERNAL,
      requiresSenderFeeJuiceBalanceCheck: false,
    });
  });

  it("uses sender fee juice by default on testnet", () => {
    expect(resolveFeeStrategy("testnet", from)).toEqual({
      useSponsoredPaymentMethod: false,
      accountFeePaymentMethodOptions:
        AccountFeePaymentMethodOptions.PREEXISTING_FEE_JUICE,
      requiresSenderFeeJuiceBalanceCheck: true,
    });
  });

  it("keeps explicit self fee payer as fee-juice-with-claim", () => {
    expect(resolveFeeStrategy("testnet", from, from)).toEqual({
      useSponsoredPaymentMethod: false,
      accountFeePaymentMethodOptions:
        AccountFeePaymentMethodOptions.FEE_JUICE_WITH_CLAIM,
      requiresSenderFeeJuiceBalanceCheck: false,
    });
  });

  it("keeps explicit external fee payer unchanged", () => {
    expect(
      resolveFeeStrategy("testnet", from, AztecAddress.fromBigInt(2n)),
    ).toEqual({
      useSponsoredPaymentMethod: false,
      accountFeePaymentMethodOptions:
        AccountFeePaymentMethodOptions.EXTERNAL,
      requiresSenderFeeJuiceBalanceCheck: false,
    });
  });
});
