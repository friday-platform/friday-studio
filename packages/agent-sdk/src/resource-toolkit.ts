/**
 * Operational surface for workspace resource access.
 * Lifecycle methods (init, provision, destroy) live on the full ResourceStorageAdapter
 * in @atlas/ledger. The Ledger HTTP client satisfies this interface structurally.
 */
export interface ResourceToolkit {
  /** Read-only query. Resolves slug to draft row, wraps agent SQL in CTE scope. */
  query(workspaceId: string, slug: string, rawSql: string, params?: unknown[]): Promise<unknown>;

  /** Mutation via SELECT. Agent SELECT computes new data; adapter applies UPDATE to draft, sets dirty. */
  mutate(workspaceId: string, slug: string, rawSql: string, params?: unknown[]): Promise<unknown>;

  /** Snapshot draft as new immutable version. No-op if draft is not dirty. */
  publish(workspaceId: string, slug: string): Promise<unknown>;

  /** Insert new version with updated ref data. Only valid for ref types. */
  linkRef(workspaceId: string, slug: string, ref: string): Promise<unknown>;

  /** List all non-deleted resources for a workspace. */
  listResources(workspaceId: string): Promise<unknown>;
}
