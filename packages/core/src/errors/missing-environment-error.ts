/**
 * Thrown when a workspace requires environment variables that are not set.
 * Lets route handlers use `instanceof` instead of string matching on error messages.
 * The detailed message (with file paths, variable names) stays in logs;
 * route handlers should return a sanitized message to API clients.
 */
export class MissingEnvironmentError extends Error {
  override readonly name = "MissingEnvironmentError";

  constructor(message: string) {
    super(message);
  }
}
