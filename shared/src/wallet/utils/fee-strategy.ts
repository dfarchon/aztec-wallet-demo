import { AccountFeePaymentMethodOptions } from "@aztec/entrypoints/account";
import { AztecAddress } from "@aztec/aztec.js/addresses";

export type FeeStrategyDecision = {
  useSponsoredPaymentMethod: boolean;
  accountFeePaymentMethodOptions: number;
  requiresSenderFeeJuiceBalanceCheck: boolean;
};

export function resolveFeeStrategy(
  networkId: string | undefined,
  from: AztecAddress,
  feePayer?: AztecAddress,
): FeeStrategyDecision {
  if (!feePayer) {
    const useSponsoredPaymentMethod = networkId === "localhost";
    return {
      useSponsoredPaymentMethod,
      accountFeePaymentMethodOptions: useSponsoredPaymentMethod
        ? AccountFeePaymentMethodOptions.EXTERNAL
        : AccountFeePaymentMethodOptions.PREEXISTING_FEE_JUICE,
      requiresSenderFeeJuiceBalanceCheck: !useSponsoredPaymentMethod,
    };
  }

  return {
    useSponsoredPaymentMethod: false,
    accountFeePaymentMethodOptions: from.equals(feePayer)
      ? AccountFeePaymentMethodOptions.FEE_JUICE_WITH_CLAIM
      : AccountFeePaymentMethodOptions.EXTERNAL,
    requiresSenderFeeJuiceBalanceCheck: false,
  };
}
