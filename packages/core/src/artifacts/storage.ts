import process from "node:process";
import { createLogger } from "@atlas/logger";
import { CortexStorageAdapter } from "./cortex-adapter.ts";
import { LocalStorageAdapter } from "./local-adapter.ts";
import type { ArtifactDataInput, CreateArtifactInput } from "./model.ts";
import type { ArtifactStorageAdapter, ReadDatabasePreviewOptions } from "./types.ts";

const logger = createLogger({ name: "artifact-storage" });

/**
 * Create artifact storage adapter based on environment configuration.
 *
 * Auto-detects adapter from CORTEX_URL presence:
 * - If CORTEX_URL is set: Uses Cortex adapter (FRIDAY_KEY read at request time)
 * - Otherwise: Uses local adapter
 *
 * Environment Variables:
 * - CORTEX_URL: Cortex service URL (presence enables Cortex adapter)
 * - FRIDAY_KEY: JWT token for Cortex authentication (read at request time, not startup)
 * - ARTIFACT_STORAGE_PATH: Override default KV path (local only)
 */
function createArtifactStorageAdapter(): ArtifactStorageAdapter {
  const cortexUrl = process.env.CORTEX_URL;

  if (cortexUrl) {
    // FRIDAY_KEY is read from env at request time, not module load (same pattern as Link routes)
    logger.info("Using CortexStorageAdapter", { cortexUrl });
    return new CortexStorageAdapter(cortexUrl);
  }

  const kvPath = process.env.ARTIFACT_STORAGE_PATH;
  logger.info("Using LocalStorageAdapter", { kvPath: kvPath || "default" });
  return new LocalStorageAdapter(kvPath);
}

// Create singleton adapter instance
const adapter = createArtifactStorageAdapter();

/**
 * Artifact storage facade.
 *
 * Delegates all operations to the configured storage adapter (local or cortex).
 * The adapter is selected once at startup based on environment variables.
 *
 * All consumers should import this facade, not the adapters directly.
 */
export const ArtifactStorage: ArtifactStorageAdapter = {
  create: (input: CreateArtifactInput) => adapter.create(input),
  update: (input: {
    id: string;
    data: ArtifactDataInput;
    title?: string;
    summary: string;
    revisionMessage?: string;
  }) => adapter.update(input),
  get: (input: { id: string; revision?: number }) => adapter.get(input),
  getManyLatest: (input: { ids: string[] }) => adapter.getManyLatest(input),
  listAll: (input: { limit?: number; includeData?: boolean }) => adapter.listAll(input),
  listByWorkspace: (input: { workspaceId: string; limit?: number; includeData?: boolean }) =>
    adapter.listByWorkspace(input),
  listByChat: (input: { chatId: string; limit?: number; includeData?: boolean }) =>
    adapter.listByChat(input),
  deleteArtifact: (input: { id: string }) => adapter.deleteArtifact(input),
  readFileContents: (input: { id: string; revision?: number }) => adapter.readFileContents(input),
  readBinaryContents: (input: { id: string; revision?: number }) =>
    adapter.readBinaryContents(input),
  readDatabasePreview: (input: ReadDatabasePreviewOptions) => adapter.readDatabasePreview(input),
  downloadDatabaseFile: (input: { id: string; revision?: number; outputDir?: string }) =>
    adapter.downloadDatabaseFile(input),
};
