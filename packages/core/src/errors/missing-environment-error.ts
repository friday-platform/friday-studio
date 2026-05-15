/**
 * Thrown when a workspace requires environment variables that are not set.
 * Lets route handlers use `instanceof` instead of string matching on error messages.
 * The detailed message (with file paths, variable names) stays in logs;
 * route handlers should return a sanitized message to API clients.
 *
 * `missingVars` carries the structured offender list so callers can degrade
 * gracefully (e.g. drop just the misconfigured MCP servers) instead of only
 * having the formatted message to string-match on.
 */
export class MissingEnvironmentError extends Error {
  override readonly name = "MissingEnvironmentError";
  readonly missingVars: ReadonlyArray<{ serverId: string; varName: string }>;

  constructor(
    message: string,
    missingVars: ReadonlyArray<{ serverId: string; varName: string }> = [],
  ) {
    super(message);
    this.missingVars = missingVars;
  }
}
