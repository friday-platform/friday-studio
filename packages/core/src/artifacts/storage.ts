import process from "node:process";
import { createLogger } from "@atlas/logger";
import { LocalStorageAdapter } from "./local-adapter.ts";
import type { ArtifactDataInput, CreateArtifactInput } from "./model.ts";
import type { ArtifactStorageAdapter } from "./types.ts";

const logger = createLogger({ name: "artifact-storage" });

/**
 * Environment Variables:
 * - ARTIFACT_STORAGE_PATH: Override default Deno KV path.
 *
 * The remote-backend (Cortex) variant of this adapter was deleted 2026-05-02 —
 * speculative infrastructure that was env-gated behind `CORTEX_URL` and never
 * reached. When a real cloud-backend story returns, build it against the
 * redesigned Object-Store-backed model, not the legacy Deno KV shape.
 */
const kvPath = process.env.ARTIFACT_STORAGE_PATH;
logger.info("Using LocalStorageAdapter", { kvPath: kvPath || "default" });
const adapter: ArtifactStorageAdapter = new LocalStorageAdapter(kvPath);

/**
 * Artifact storage facade. Delegates to the local adapter (the only one
 * since 2026-05-02). All consumers import this facade, not the adapter.
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
};
