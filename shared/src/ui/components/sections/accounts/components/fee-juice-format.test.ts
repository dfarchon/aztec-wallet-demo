import { describe, expect, it } from "vitest";
import { formatFeeJuiceBalance } from "./fee-juice-format";

describe("formatFeeJuiceBalance", () => {
  it("formats zero", () => {
    expect(formatFeeJuiceBalance("0")).toBe("0");
  });

  it("formats whole units", () => {
    expect(formatFeeJuiceBalance("1000000000000000000")).toBe("1");
  });

  it("formats fractional units", () => {
    expect(formatFeeJuiceBalance("1500000000000000000")).toBe("1.5");
  });

  it("formats the minimum positive balance", () => {
    expect(formatFeeJuiceBalance("1")).toBe("0.000000000000000001");
  });

  it("adds thousand separators and trims trailing zeros", () => {
    expect(formatFeeJuiceBalance("1234567890123456789000")).toBe(
      "1,234.567890123456789",
    );
  });
});
