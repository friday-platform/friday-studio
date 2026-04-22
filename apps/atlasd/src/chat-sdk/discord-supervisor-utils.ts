/**
 * Shared primitives for supervising a DiscordAdapter Gateway listener. The
 * daemon-level `DiscordGatewayService` is the sole consumer — kept in its own
 * module so the Chat SDK instance layer has no remaining Discord-specific
 * supervision code.
 */

export const DISCORD_GATEWAY_DURATION_MS = 12 * 60 * 60 * 1000;
export const DISCORD_GATEWAY_RETRY_DELAY_MS = 30_000;

/**
 * Authentication failures — stop the supervisor hard. Retrying with a bad
 * bot token risks Discord rate-limiting or banning the token. Checks three
 * shapes that discord.js / @discordjs/rest can surface:
 *   - `DiscordAPIError` with `.code === "TokenInvalid"` or `.status === 401`
 *   - Gateway WebSocket close code 4004 (`.code === 4004`) for auth failure
 *   - Plain `Error("An invalid token was provided.")` from `client.login`
 */
export function isDiscordAuthError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = "code" in err ? err.code : undefined;
    const status = "status" in err ? err.status : undefined;
    if (code === "TokenInvalid" || code === 4004 || status === 401) {
      return true;
    }
    return /invalid token|unauthor|\b401\b/i.test(err.message);
  }
  return /invalid token|unauthor|\b401\b/i.test(String(err));
}

/** Resolves early if the signal aborts, otherwise after `ms` ticks. */
export function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
