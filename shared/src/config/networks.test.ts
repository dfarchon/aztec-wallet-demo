import { describe, expect, it } from "vitest";
import {
  DEFAULT_NETWORK,
  getNetworkByChainId,
  getNetworkById,
  getSelectableNetworkById,
  getSelectableNetworks,
} from "./networks";

describe("network configuration", () => {
  it("exposes only localhost and testnet as selectable networks", () => {
    expect(getSelectableNetworks().map((network) => network.id)).toEqual([
      "localhost",
      "testnet",
    ]);
  });

  it("keeps devnet defined but not selectable", () => {
    expect(getNetworkById("devnet")).toBeDefined();
    expect(getSelectableNetworkById("devnet")).toBeUndefined();
  });

  it("configures testnet with the expected chain values", () => {
    expect(getNetworkById("testnet")).toMatchObject({
      id: "testnet",
      nodeUrl: "https://rpc.testnet.aztec-labs.com",
      chainId: 11155111,
      version: 4127419662,
      selectable: true,
    });
  });

  it("matches testnet by chain id and version", () => {
    expect(getNetworkByChainId(11155111, 4127419662)?.id).toBe("testnet");
  });

  it("defaults to testnet", () => {
    expect(DEFAULT_NETWORK.id).toBe("testnet");
  });
});
