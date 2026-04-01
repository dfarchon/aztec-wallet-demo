import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_NETWORK,
  getSelectableNetworkById,
  getSelectableNetworks,
  type NetworkConfig,
} from "../../config/networks";

interface NetworkContextType {
  currentNetwork: NetworkConfig;
  availableNetworks: NetworkConfig[];
  switchNetwork: (networkId: string) => void;
  isNetworkSwitching: boolean;
}

const NetworkContext = createContext<NetworkContextType | undefined>(undefined);

const NETWORK_STORAGE_KEY = "aztec-keychain-selected-network";

interface NetworkProviderProps {
  children: ReactNode;
}

export function NetworkProvider({ children }: NetworkProviderProps) {
  const [isNetworkSwitching, setIsNetworkSwitching] = useState(false);
  const availableNetworks = getSelectableNetworks();

  // Initialize network from localStorage or use default
  const [currentNetwork, setCurrentNetwork] = useState<NetworkConfig>(() => {
    const savedNetworkId = localStorage.getItem(NETWORK_STORAGE_KEY);
    if (savedNetworkId) {
      const network = getSelectableNetworkById(savedNetworkId);
      if (network) return network;
    }
    return DEFAULT_NETWORK;
  });

  const switchNetwork = (networkId: string) => {
    const network = getSelectableNetworkById(networkId);
    if (!network) {
      console.error(`Selectable network with id ${networkId} not found`);
      return;
    }

    setIsNetworkSwitching(true);

    // Simulate a brief delay for network switching
    // This gives time for cleanup and initialization
    setTimeout(() => {
      setCurrentNetwork(network);
      localStorage.setItem(NETWORK_STORAGE_KEY, networkId);
      setIsNetworkSwitching(false);
    }, 100);
  };

  const value: NetworkContextType = {
    currentNetwork,
    availableNetworks,
    switchNetwork,
    isNetworkSwitching,
  };

  return (
    <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
  );
}

export function useNetwork(): NetworkContextType {
  const context = useContext(NetworkContext);
  if (context === undefined) {
    throw new Error("useNetwork must be used within a NetworkProvider");
  }
  return context;
}
