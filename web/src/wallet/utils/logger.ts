import { createLogger, type Logger } from "@aztec/aztec.js/log";

// In the browser wallet we just use the standard aztec logger directly.
// No proxy needed since there's no separate worker thread to route logs through.
export function createProxyLogger(prefix: string): Logger {
  return createLogger(prefix);
}
