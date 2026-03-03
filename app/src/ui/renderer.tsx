import { createRoot } from "react-dom/client";
import { Root } from "@demo-wallet/shared/ui";
import { WalletApi } from "./utils/wallet-api.js";

const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
root.render(<Root walletApiFactory={WalletApi.create} />);
