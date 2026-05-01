/**
 * Adapts an `@atlas/logger` Logger to the structural interface that
 * `@chat-adapter/discord` (and the rest of the Vercel Chat SDK) expects, so
 * adapter-internal diagnostic output — Gateway connect/disconnect, inbound
 * event logs, signature-verification failures — lands in `global.log` instead
 * of daemon stdout.
 *
 * The upstream interface (`opensrc/.../chat/src/logger.ts`) takes variadic
 * `...args: unknown[]` and a string prefix on `child()`, while `@atlas/logger`
 * takes a `LogContext` object. We coalesce args into a `{ args }` context and
 * translate the string prefix into `{ component: prefix }` on `child()`.
 */
import type { Logger } from "@atlas/logger";

/**
 * Minimal structural interface matching the Vercel Chat SDK's Logger. Declared
 * locally rather than imported from upstream to avoid dragging chat-sdk
 * runtime deps into this file.
 */
export interface ChatSdkLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(prefix: string): ChatSdkLogger;
}

function toContext(args: unknown[]): { args: unknown[] } | undefined {
  return args.length === 0 ? undefined : { args };
}

export function toDiscordLogger(atlasLogger: Logger): ChatSdkLogger {
  return {
    debug(message, ...args) {
      atlasLogger.debug(message, toContext(args));
    },
    info(message, ...args) {
      atlasLogger.info(message, toContext(args));
    },
    warn(message, ...args) {
      atlasLogger.warn(message, toContext(args));
    },
    error(message, ...args) {
      atlasLogger.error(message, toContext(args));
    },
    child(prefix) {
      return toDiscordLogger(atlasLogger.child({ component: prefix }));
    },
  };
}
