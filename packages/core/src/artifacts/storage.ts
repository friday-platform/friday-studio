import process from "node:process";
import { createLogger } from "@atlas/logger";
import { CortexStorageAdapter } from "./cortex-adapter.ts";
import { LocalStorageAdapter } from "./local-adapter.ts";
import type { ArtifactDataInput, CreateArtifactInput } from "./model.ts";
import type { ArtifactStorageAdapter } from "./types.ts";

const logger = createLogger({ name: "artifact-storage" });

/**
 * Create artifact storage adapter based on environment configuration.
 *
 * Environment Variables:
 * - ARTIFACT_STORAGE_ADAPTER: "local" (default) or "cortex"
 * - ARTIFACT_STORAGE_PATH: Override default KV path (local only)
 * - CORTEX_URL: Cortex service URL (required for cortex adapter)
 * - ATLAS_KEY: JWT token for Cortex authentication (read at request time, not startup)
 */
function createArtifactStorageAdapter(): ArtifactStorageAdapter {
  const adapterType = process.env.ARTIFACT_STORAGE_ADAPTER || "local";

  switch (adapterType) {
    case "local": {
      const kvPath = process.env.ARTIFACT_STORAGE_PATH;
      logger.info("Using LocalStorageAdapter", { kvPath: kvPath || "default" });
      return new LocalStorageAdapter(kvPath);
    }

    case "cortex": {
      const cortexUrl = process.env.CORTEX_URL;
      if (!cortexUrl) {
        throw new Error(
          "CORTEX_URL environment variable is required when ARTIFACT_STORAGE_ADAPTER=cortex",
        );
      }

      // ATLAS_KEY is read from env at request time, not module load (same pattern as Link routes)
      logger.info("Using CortexStorageAdapter", { cortexUrl });
      return new CortexStorageAdapter(cortexUrl);
    }

    default:
      throw new Error(
        `Unknown artifact storage adapter type: ${adapterType}. Valid options: local, cortex`,
      );
  }
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
  listAll: (input: { limit?: number }) => adapter.listAll(input),
  listByWorkspace: (input: { workspaceId: string; limit?: number }) =>
    adapter.listByWorkspace(input),
  listByChat: (input: { chatId: string; limit?: number }) => adapter.listByChat(input),
  deleteArtifact: (input: { id: string }) => adapter.deleteArtifact(input),
  readFileContents: (input: { id: string; revision?: number }) => adapter.readFileContents(input),
};
