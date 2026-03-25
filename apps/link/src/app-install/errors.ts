export type AppInstallErrorCode =
  | "PROVIDER_NOT_FOUND" // Provider ID not in registry
  | "INVALID_PROVIDER_TYPE" // Provider exists but not app_install
  | "STATE_INVALID" // State JWT invalid/expired
  | "MISSING_CODE" // No authorization code in callback
  | "APPROVAL_PENDING" // GitHub App installation requires admin approval
  | "SLACK_NETWORK_ERROR" // DNS, timeout, connection refused
  | "SLACK_HTTP_ERROR" // Non-2xx from Slack
  | "SLACK_PARSE_ERROR" // Invalid JSON from Slack
  | "SLACK_OAUTH_ERROR" // Slack returned ok: false
  | "SLACK_REFRESH_ERROR" // Slack token refresh failed
  | "NOT_REFRESHABLE" // Credential cannot be refreshed (e.g., missing refresh_token)
  | "REFRESH_ERROR" // Token refresh failed (network, API, etc.)
  | "INSTALLATION_OWNED" // Installation belongs to another user
  | "CREDENTIAL_NOT_FOUND" // Race condition
  | "CREDENTIAL_INCOMPLETE" // Credential exists but OAuth flow not completed
  | "INVALID_CREDENTIAL" // Missing expected fields
  | "SLACK_API_ERROR"; // Slack returned non-ok or non-2xx

export class AppInstallError extends Error {
  constructor(
    public readonly code: AppInstallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppInstallError";
  }
}
