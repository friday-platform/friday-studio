export type GitHubAppErrorCode =
  | "OAUTH_CODE_EXCHANGE_FAILED"
  | "OAUTH_INVALID_RESPONSE"
  | "INSTALLATIONS_LIST_FAILED"
  | "INSTALLATION_NOT_FOUND"
  | "INSTALLATION_ID_INVALID"
  | "TOKEN_MINT_FAILED";

export class GitHubAppError extends Error {
  constructor(
    public readonly code: GitHubAppErrorCode,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "GitHubAppError";
  }
}
