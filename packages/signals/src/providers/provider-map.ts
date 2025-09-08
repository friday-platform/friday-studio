/**
 * Static Provider Map - Replaces dynamic imports with static imports
 * This eliminates the need for dynamic imports and factory patterns
 */

import { CliSignalProvider } from "./cli-signal.ts";
import { HTTPSignalProvider } from "./http-signal.ts";
import { HttpWebhookProvider } from "./http-webhook.ts";
import { K8sEventsSignalProvider } from "./k8s-events.ts";
import { StreamSignalProvider } from "./stream-signal.ts";
import { TimerSignalProvider } from "./timer-signal.ts";
import { FileWatchSignalProvider } from "./fs-watch-signal.ts";

/**
 * Map of provider type strings to their corresponding class constructors
 * This provides static access to all built-in provider classes
 */
export const PROVIDER_CLASSES = {
  http: HTTPSignalProvider,
  "http-webhook": HttpWebhookProvider,
  timer: TimerSignalProvider,
  schedule: TimerSignalProvider,
  cron: TimerSignalProvider,
  "cron-scheduler": TimerSignalProvider,
  stream: StreamSignalProvider,
  "k8s-events": K8sEventsSignalProvider,
  cli: CliSignalProvider,
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
