import type { ResourceStorageAdapter } from "@atlas/ledger";

/**
 * @description Operational surface for workspace resource access.
 * Subset of ResourceStorageAdapter — omits lifecycle methods (init, provision,
 * destroy) that agents don't need. The Ledger HTTP client satisfies this
 * interface structurally.
 */
export type ResourceToolkit = Pick<
  ResourceStorageAdapter,
  "query" | "mutate" | "publish" | "linkRef" | "listResources"
>;
