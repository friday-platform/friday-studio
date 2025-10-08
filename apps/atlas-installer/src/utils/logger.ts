import { getErrorMessage } from "./errors";

/**
 * Creates a logger instance with a specific prefix
 */
export function createLogger(prefix: string) {
  return {
    info: (msg: string) => console.log(`[${prefix}] ${msg}`),
    error: (msg: string, error?: unknown) => {
      console.error(`[${prefix}] ${msg}`);
      if (error) {
        console.error(`[${prefix}] Error details:`, getErrorMessage(error));
      }
    },
    warn: (msg: string) => console.warn(`[${prefix}] ${msg}`),
  };
}
