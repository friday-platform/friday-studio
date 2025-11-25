/**
 * Discord integration error classes
 */

/**
 * User-facing error that's safe to show in Discord
 */
export class DiscordCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordCommandError";
  }
}

/**
 * Internal error that should be logged but not exposed to users
 */
export class DiscordInternalError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, { cause });
    this.name = "DiscordInternalError";
  }
}
