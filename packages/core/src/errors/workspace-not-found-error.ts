/**
 * Thrown when a workspace cannot be found in the registry by ID or name.
 * Lets route handlers use `instanceof` instead of string matching on error messages.
 */
export class WorkspaceNotFoundError extends Error {
  override readonly name = "WorkspaceNotFoundError";

  constructor(workspaceId: string) {
    super(`Workspace not found: ${workspaceId}`);
  }
}
