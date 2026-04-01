import { Fr } from "@aztec/aztec.js/fields";

export interface NetworkConfig {
  id: string;
  name: string;
  chainId: number;
  version: number;
  description: string;
  color: string;
  selectable: boolean;
  nodeUrl?: string;
}

export const NETWORKS: NetworkConfig[] = [
  {
    id: "localhost",
    name: "Localhost",
    chainId: 31337,
    version: 344372055, // Auto-detect version
    description: "Local development network",
    color: "#4caf50",
    selectable: true,
    nodeUrl: "http://localhost:8080",
  },
  {
    id: "devnet",
    name: "Devnet",
    chainId: 11155111,
    version: 615022430,
    description: "Aztec Labs Devnet",
    color: "#2196f3",
    selectable: false,
    nodeUrl: "https://v4-devnet-2.aztec-labs.com/",
  },
  {
    id: "testnet",
    name: "Testnet",
    chainId: 11155111,
    version: 4127419662,
    description: "Aztec Labs Testnet",
    color: "#f321c9",
    selectable: true,
    nodeUrl: "https://rpc.testnet.aztec-labs.com",
  },
];

export const DEFAULT_NETWORK = NETWORKS.find(
  (network) => network.id === "testnet",
)!;

export function getNetworkById(id: string): NetworkConfig | undefined {
  return NETWORKS.find((network) => network.id === id);
}

export function getSelectableNetworks(): NetworkConfig[] {
  return NETWORKS.filter((network) => network.selectable);
}

export function getSelectableNetworkById(
  id: string,
): NetworkConfig | undefined {
  return getSelectableNetworks().find((network) => network.id === id);
}

export function getNetworkByChainId(
  chainId: number,
  version?: number,
): NetworkConfig | undefined {
  return NETWORKS.find((network) => {
    if (network.version !== 0) {
      return network.chainId === chainId && network.version === version;
    }
    return network.chainId === chainId;
  });
}

export function networkToChainInfo(network: NetworkConfig): {
  chainId: Fr;
  version: Fr;
} {
  return {
    chainId: new Fr(network.chainId),
    version: new Fr(network.version),
  };
}
