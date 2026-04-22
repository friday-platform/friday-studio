/**
 * Canonical workspace constants and guard functions.
 *
 * Canonical workspaces cannot be deleted. System canonical workspaces
 * are also non-renamable and non-user-editable. Personal canonical
 * workspaces are renamable and user-editable but still non-deletable.
 */

import type { WorkspaceMetadata } from "./types.ts";

/** The two canonical workspace kinds. */
export type CanonicalWorkspaceKind = "personal" | "system";

/** Well-known canonical workspace IDs. */
export const CANONICAL_WORKSPACE_IDS = { PERSONAL: "user", SYSTEM: "system" } as const;

export type CanonicalWorkspaceId =
  (typeof CANONICAL_WORKSPACE_IDS)[keyof typeof CANONICAL_WORKSPACE_IDS];

/** Constraints for each canonical kind. */
export const CANONICAL_CONSTRAINTS: Record<
  CanonicalWorkspaceKind,
  { deletable: false; renamable: boolean; userEditable: boolean; displayName: string }
> = {
  personal: { deletable: false, renamable: true, userEditable: true, displayName: "Personal" },
  system: { deletable: false, renamable: false, userEditable: false, displayName: "System" },
} as const;

const canonicalIdToKind: Record<string, CanonicalWorkspaceKind> = {
  [CANONICAL_WORKSPACE_IDS.PERSONAL]: "personal",
  [CANONICAL_WORKSPACE_IDS.SYSTEM]: "system",
  // Legacy alias — early canonical.ts used "atlas-personal" before the
  // first-run-bootstrap settled on "user" as the stable ID.
  "atlas-personal": "personal",
};

/** Returns the canonical kind for a workspace ID, or undefined if not canonical. */
export function getCanonicalKind(workspaceId: string): CanonicalWorkspaceKind | undefined {
  return canonicalIdToKind[workspaceId];
}

/** Returns true if the given workspace ID is a canonical workspace. */
export function isCanonical(workspaceId: string): boolean {
  return workspaceId in canonicalIdToKind;
}

/** Returns true if the workspace metadata indicates a canonical workspace. */
export function isCanonicalEntry(metadata: WorkspaceMetadata | undefined): boolean {
  return metadata?.canonical !== undefined;
}
