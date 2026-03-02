/**
 * Web Wallet entry point.
 *
 * Detects whether the wallet is loaded in an iframe or standalone and
 * renders the appropriate shell:
 *
 *   - iframe  (window.self !== window.top) → IframeShell
 *     Minimal UI: authorization dialogs only, starts IframeConnectionHandler
 *     to handle postMessage from the embedding dApp.
 *
 *   - standalone (window.self === window.top) → StandaloneShell
 *     Full wallet UI: account management, contacts, history, etc.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { IframeShell } from "./ui/IframeShell.tsx";
import { StandaloneShell } from "./ui/StandaloneShell.tsx";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("No #root element found");

const isIframe = window.self !== window.top;
const Shell = isIframe ? IframeShell : StandaloneShell;

createRoot(rootElement).render(createElement(Shell));
