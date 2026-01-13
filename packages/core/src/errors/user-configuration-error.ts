/**
 * Error for user configuration issues (OAuth not connected, missing env vars).
 * Sessions with this error are recorded as "skipped" not "failed" in metrics,
 * preventing false alerts for expected user setup states.
 */
export class UserConfigurationError extends Error {
  override readonly name = "UserConfigurationError";

  private constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }

  /** Create error for failed credential refresh */
  static credentialRefreshFailed(
    agentId: string,
    provider: string,
    cause?: unknown,
  ): UserConfigurationError {
    return new UserConfigurationError(
      `Can't execute ${agentId}: Your '${provider}' credentials could not be refreshed. Please reconnect your account.`,
      cause ? { cause } : undefined,
    );
  }

  /** Create error for missing OAuth providers and/or env vars */
  static missingConfiguration(
    agentId: string,
    workspaceId: string,
    missingProviders: string[],
    missingVariables: string[],
  ): UserConfigurationError {
    const parts: string[] = [];

    // Link credentials require OAuth connection, not .env file
    if (missingProviders.length > 0) {
      const providers = missingProviders.join(", ");
      const plural = missingProviders.length > 1 ? "s" : "";
      parts.push(`Please connect your ${providers} account${plural} to continue.`);
    }

    // Regular env vars need .env file
    if (missingVariables.length > 0) {
      const vars = missingVariables.join(", ");
      parts.push(
        `Required environment variables not found: ${vars}. Please add these to your workspace .env file.`,
      );
    }

    return new UserConfigurationError(
      `Can't execute ${agentId} in workspace '${workspaceId}': ${parts.join(" ")}`,
    );
  }
}
