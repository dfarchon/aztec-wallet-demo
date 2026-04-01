const FEE_JUICE_DECIMALS = 18;

function addThousandsSeparators(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatFeeJuiceBalance(baseUnits: string): string {
  const normalized = BigInt(baseUnits).toString();
  const negative = normalized.startsWith("-");
  const digits = negative ? normalized.slice(1) : normalized;
  const padded = digits.padStart(FEE_JUICE_DECIMALS + 1, "0");
  const integerPart =
    padded.slice(0, -FEE_JUICE_DECIMALS).replace(/^0+(?=\d)/, "") || "0";
  const fractionalPart = padded
    .slice(-FEE_JUICE_DECIMALS)
    .replace(/0+$/, "");
  const formattedInteger = addThousandsSeparators(integerPart);
  const sign = negative ? "-" : "";

  return fractionalPart
    ? `${sign}${formattedInteger}.${fractionalPart}`
    : `${sign}${formattedInteger}`;
}
