import type { Result } from "@atlas/utils";
import type { NatsConnection } from "nats";
import { JetStreamArtifactStorageAdapter } from "./jetstream-adapter.ts";
import type { Artifact, ArtifactDataInput, ArtifactSummary, CreateArtifactInput } from "./model.ts";
import type { ArtifactStorageAdapter } from "./types.ts";

let adapter: ArtifactStorageAdapter | null = null;

/**
 * Wire artifact storage to a NATS connection. Daemon calls this once at
 * startup. Subsequent `ArtifactStorage.*` calls go through the JetStream
 * KV + Object Store adapter.
 */
export function initArtifactStorage(nc: NatsConnection): void {
  adapter = new JetStreamArtifactStorageAdapter(nc);
}

function require_(): ArtifactStorageAdapter {
  if (!adapter) {
    throw new Error(
      "Artifact storage not initialized — call initArtifactStorage(nc) at daemon startup",
    );
  }
  return adapter;
}

/**
 * Artifact storage facade. Delegates to the JetStream-backed adapter
 * once `initArtifactStorage(nc)` has been called.
 */
export const ArtifactStorage: ArtifactStorageAdapter = {
  create: (input: CreateArtifactInput): Promise<Result<Artifact, string>> =>
    require_().create(input),
  update: (input: {
    id: string;
    data: ArtifactDataInput;
    title?: string;
    summary: string;
    revisionMessage?: string;
  }): Promise<Result<Artifact, string>> => require_().update(input),
  get: (input: { id: string; revision?: number }): Promise<Result<Artifact | null, string>> =>
    require_().get(input),
  getManyLatest: (input: { ids: string[] }): Promise<Result<Artifact[], string>> =>
    require_().getManyLatest(input),
  listAll: (input: {
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>> => require_().listAll(input),
  listByWorkspace: (input: {
    workspaceId: string;
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>> => require_().listByWorkspace(input),
  listByChat: (input: {
    chatId: string;
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>> => require_().listByChat(input),
  deleteArtifact: (input: { id: string }): Promise<Result<void, string>> =>
    require_().deleteArtifact(input),
  readFileContents: (input: { id: string; revision?: number }): Promise<Result<string, string>> =>
    require_().readFileContents(input),
  readBinaryContents: (input: {
    id: string;
    revision?: number;
  }): Promise<Result<Uint8Array, string>> => require_().readBinaryContents(input),
};
