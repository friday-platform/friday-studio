/**
 * Static Provider Map - Replaces dynamic imports with static imports
 * This eliminates the need for dynamic imports and factory patterns
 */

import { FileWatchSignalProvider } from "./fs-watch-signal.ts";
import { HTTPSignalProvider } from "./http-signal.ts";

/**
 * Map of provider type strings to their corresponding class constructors
 * This provides static access to all built-in provider classes
 */
export const PROVIDER_CLASSES = {
  http: HTTPSignalProvider,
  "fs-watch": FileWatchSignalProvider,
} as const;

/**
 * Type-safe keys for provider types
 */
export type ProviderTypeKeys = keyof typeof PROVIDER_CLASSES;

/**
 * Type-safe access to provider class constructors
 */
export type ProviderConstructor<T extends ProviderTypeKeys> = (typeof PROVIDER_CLASSES)[T];
