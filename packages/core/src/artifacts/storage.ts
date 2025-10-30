import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { typeByExtension } from "@std/media-types";
import { extname, join } from "@std/path";
import type {
  Artifact,
  ArtifactData,
  ArtifactDataInput,
  ArtifactRevisionSummary,
  CreateArtifactInput,
} from "./model.ts";

type ArtifactKey = ["artifact", string, number];
type LatestKey = ["artifact_latest", string];
type ByWorkspaceKey = ["artifacts_by_workspace", string, string];
type ByChatKey = ["artifacts_by_chat", string, string];
type DeletedKey = ["artifact_deleted", string];

const keys = {
  artifact: (id: string, revision: number): ArtifactKey => ["artifact", id, revision],
  latest: (id: string): LatestKey => ["artifact_latest", id],
  byWorkspace: (workspaceId: string, id: string): ByWorkspaceKey => [
    "artifacts_by_workspace",
    workspaceId,
    id,
  ],
  byChat: (chatId: string, id: string): ByChatKey => ["artifacts_by_chat", chatId, id],
  deleted: (id: string): DeletedKey => ["artifact_deleted", id],
};

const kvPath = join(getAtlasHome(), "storage.db");

/**
 * Detect MIME type from file path
 */
function detectMimeType(filePath: string): string {
  const ext = extname(filePath);
  const detected = typeByExtension(ext);
  return detected || "application/octet-stream";
}

/** Create artifact with initial revision 1 */
async function create(input: CreateArtifactInput): Promise<Result<Artifact, string>> {
  using db = await Deno.openKv(kvPath);

  // Transform input to output by enriching file artifacts
  let artifactData: ArtifactData;

  if (input.data.type === "file") {
    const fileInput = input.data.data;

    try {
      await Deno.stat(fileInput.path);
    } catch (error) {
      return fail(`File not found: ${fileInput.path} (${stringifyError(error)})`);
    }

    const mimeType = detectMimeType(fileInput.path);
    artifactData = { type: "file", version: 1, data: { path: fileInput.path, mimeType } };
  } else {
    artifactData = input.data;
  }

  const id = crypto.randomUUID();
  const revision = 1;

  const artifact: Artifact = {
    id,
    type: artifactData.type,
    revision,
    data: artifactData,
    summary: input.summary,
    workspaceId: input.workspaceId,
    chatId: input.chatId,
    createdAt: new Date().toISOString(),
  };

  const tx = db.atomic();
  const primaryKey = keys.artifact(id, revision);

  tx.set(primaryKey, artifact);
  tx.set(keys.latest(id), revision);

  if (input.workspaceId) {
    tx.set(keys.byWorkspace(input.workspaceId, id), primaryKey);
  }
  if (input.chatId) {
    tx.set(keys.byChat(input.chatId, id), primaryKey);
  }

  const result = await tx.commit();
  if (!result.ok) {
    return fail("Failed to create artifact");
  }

  return success(artifact);
}

/** Create new revision (preserves history) */
async function update(input: {
  id: string;
  data: ArtifactDataInput;
  summary: string;
  revisionMessage?: string;
}): Promise<Result<Artifact, string>> {
  using db = await Deno.openKv(kvPath);

  const latestRevisionResult = await db.get<number>(keys.latest(input.id));
  if (!latestRevisionResult.value) {
    return fail(`Artifact ${input.id} not found`);
  }

  const currentRevision = latestRevisionResult.value;

  const deletedResult = await db.get<Date>(keys.deleted(input.id));
  if (deletedResult.value) {
    return fail(`Artifact ${input.id} has been deleted`);
  }

  const currentArtifactResult = await db.get<Artifact>(keys.artifact(input.id, currentRevision));
  if (!currentArtifactResult.value) {
    return fail(`Artifact ${input.id} revision ${currentRevision} not found`);
  }

  const currentArtifact = currentArtifactResult.value;

  // Transform input to output by enriching file artifacts
  let artifactData: ArtifactData;

  if (input.data.type === "file") {
    const fileInput = input.data.data;

    try {
      await Deno.stat(fileInput.path);
    } catch (error) {
      return fail(`File not found: ${fileInput.path} (${stringifyError(error)})`);
    }

    const mimeType = detectMimeType(fileInput.path);
    artifactData = { type: "file", version: 1, data: { path: fileInput.path, mimeType } };
  } else {
    artifactData = input.data;
  }

  const newArtifact: Artifact = {
    id: input.id,
    type: currentArtifact.type,
    revision: currentRevision + 1,
    data: artifactData,
    summary: input.summary,
    workspaceId: currentArtifact.workspaceId,
    chatId: currentArtifact.chatId,
    createdAt: new Date().toISOString(),
    revisionMessage: input.revisionMessage,
  };

  const tx = db.atomic();
  const newPrimaryKey = keys.artifact(input.id, newArtifact.revision);

  tx.set(newPrimaryKey, newArtifact);
  tx.set(keys.latest(input.id), newArtifact.revision);

  if (newArtifact.workspaceId) {
    tx.set(keys.byWorkspace(newArtifact.workspaceId, input.id), newPrimaryKey);
  }
  if (newArtifact.chatId) {
    tx.set(keys.byChat(newArtifact.chatId, input.id), newPrimaryKey);
  }

  const result = await tx.commit();
  if (!result.ok) {
    return fail("Failed to update artifact");
  }

  return success(newArtifact);
}

/** Get artifact by ID (defaults to latest revision) */
async function get(input: {
  id: string;
  revision?: number;
}): Promise<Result<Artifact | null, string>> {
  using db = await Deno.openKv(kvPath);

  const deletedResult = await db.get<Date>(keys.deleted(input.id));
  if (deletedResult.value) {
    return success(null);
  }

  let targetRevision = input.revision;
  if (!targetRevision) {
    const latestRevisionResult = await db.get<number>(keys.latest(input.id));
    if (!latestRevisionResult.value) {
      return success(null);
    }
    targetRevision = latestRevisionResult.value;
  }

  const artifactResult = await db.get<Artifact>(keys.artifact(input.id, targetRevision));
  return success(artifactResult.value || null);
}

/** List workspace artifacts (latest revisions only) */
async function listByWorkspace(input: {
  workspaceId: string;
  limit?: number;
}): Promise<Result<Artifact[], string>> {
  using db = await Deno.openKv(kvPath);

  const artifacts: Artifact[] = [];
  const limit = input.limit ?? 100;

  const entries = db.list<ArtifactKey>({ prefix: ["artifacts_by_workspace", input.workspaceId] });

  for await (const entry of entries) {
    if (artifacts.length >= limit) break;

    const [, id] = entry.value;

    const deletedResult = await db.get<Date>(keys.deleted(id));
    if (deletedResult.value) continue;

    const artifactResult = await db.get<Artifact>(entry.value);
    if (artifactResult.value) {
      artifacts.push(artifactResult.value);
    }
  }

  return success(artifacts);
}

/** List chat artifacts (latest revisions only) */
async function listByChat(input: {
  chatId: string;
  limit?: number;
}): Promise<Result<Artifact[], string>> {
  using db = await Deno.openKv(kvPath);

  const artifacts: Artifact[] = [];
  const limit = input.limit ?? 100;

  const entries = db.list<ArtifactKey>({ prefix: ["artifacts_by_chat", input.chatId] });

  for await (const entry of entries) {
    if (artifacts.length >= limit) break;

    const [, id] = entry.value;

    const deletedResult = await db.get<Date>(keys.deleted(id));
    if (deletedResult.value) continue;

    const artifactResult = await db.get<Artifact>(entry.value);
    if (artifactResult.value) {
      artifacts.push(artifactResult.value);
    }
  }

  return success(artifacts);
}

/** Get all revisions of an artifact */
async function listRevisions(input: {
  id: string;
}): Promise<Result<ArtifactRevisionSummary[], string>> {
  using db = await Deno.openKv(kvPath);

  const latestRevisionResult = await db.get<number>(keys.latest(input.id));
  if (!latestRevisionResult.value) {
    return success([]);
  }

  const revisions: ArtifactRevisionSummary[] = [];
  for (let revision = 1; revision <= latestRevisionResult.value; revision++) {
    const artifactResult = await db.get<Artifact>(keys.artifact(input.id, revision));
    if (artifactResult.value) {
      revisions.push({
        revision: artifactResult.value.revision,
        createdAt: artifactResult.value.createdAt,
        revisionMessage: artifactResult.value.revisionMessage,
      });
    }
  }

  return success(revisions);
}

/** Soft delete (data preserved) */
async function deleteArtifact(input: { id: string }): Promise<Result<void, string>> {
  using db = await Deno.openKv(kvPath);

  const latestRevisionResult = await db.get<number>(keys.latest(input.id));
  if (!latestRevisionResult.value) {
    return fail(`Artifact ${input.id} not found`);
  }

  await db.set(keys.deleted(input.id), new Date());
  return success(undefined);
}

/**
 * Batch get artifacts by IDs (latest revisions only).
 * Missing or deleted artifacts are skipped.
 */
async function getManyLatest(input: { ids: string[] }): Promise<Result<Artifact[], string>> {
  using db = await Deno.openKv(kvPath);

  if (!input.ids || input.ids.length === 0) {
    return success([]);
  }

  const artifacts: Artifact[] = [];

  for (const id of input.ids) {
    // Skip deleted
    const deletedResult = await db.get<Date>(keys.deleted(id));
    if (deletedResult.value) continue;

    // Resolve latest revision
    const latestRevisionResult = await db.get<number>(keys.latest(id));
    const revision = latestRevisionResult.value;
    if (!revision) continue;

    const artifactResult = await db.get<Artifact>(keys.artifact(id, revision));
    if (artifactResult.value) {
      artifacts.push(artifactResult.value);
    }
  }

  return success(artifacts);
}

export const ArtifactStorage = {
  create,
  update,
  get,
  getManyLatest,
  listByWorkspace,
  listByChat,
  listRevisions,
  deleteArtifact,
};
