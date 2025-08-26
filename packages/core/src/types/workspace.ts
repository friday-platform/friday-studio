// Re-export workspace types from the workspace package (single source of truth)
export {
  type WorkspaceEntry,
  WorkspaceEntrySchema,
  type WorkspaceMetadata,
  WorkspaceMetadataSchema,
  WorkspaceStatusEnum as WorkspaceStatus,
  WorkspaceStatusSchema,
} from "@atlas/workspace";
