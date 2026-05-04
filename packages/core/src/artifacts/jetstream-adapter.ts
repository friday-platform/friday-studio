/**
 * JetStream-backed artifact storage.
 *
 * Two surfaces:
 *
 *   - **Content** → JetStream Object Store, `OBJ_artifacts`. Each blob
 *     is named by its SHA-256, so saving the same bytes twice is one
 *     Object Store entry + two metadata refs. Deduplication is free.
 *   - **Metadata** → JetStream KV, `ARTIFACTS` bucket. One key per
 *     artifact: `<id>/<revision>`. A `<id>/_latest` sentinel key
 *     points at the most-recent revision. Soft-delete is a tombstone
 *     under `<id>/_deleted`.
 *
 * **Why no atomic across the two surfaces:** JetStream KV is per-key,
 * Object Store is its own stream. We can't transactionally ensure
 * both writes commit. The mitigation is a write-blob-first then
 * write-metadata pattern: a metadata reference always points at a
 * blob that already exists; if a metadata write fails after a blob
 * write, the orphan blob gets reaped by the cleanup migration (or
 * lives forever costing whatever the dedup-deduped size is — usually
 * zero because the same hash gets re-referenced on retry).
 *
 * **Why store revisions in separate keys:** keeps history without
 * payload duplication. Object Store entries are content-addressed so
 * an unchanged blob across revisions costs zero extra bytes.
 */

import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { encodeHex } from "@std/encoding/hex";
import { fileTypeFromBuffer } from "file-type";
import { dec, enc, isCASConflict } from "jetstream";
import type { KV, NatsConnection, ObjectStore } from "nats";
import {
  type Artifact,
  type ArtifactDataInput,
  ArtifactSchema,
  type ArtifactSummary,
  type CreateArtifactInput,
} from "./model.ts";
import type { ArtifactStorageAdapter } from "./types.ts";

const logger = createLogger({ component: "jetstream-artifact-storage" });

const KV_BUCKET = "ARTIFACTS";
const OS_BUCKET = "artifacts";
const HISTORY = 5;

const SUFFIX_LATEST = "_latest";
const SUFFIX_DELETED = "_deleted";

/** Encode hierarchical key segments to JS-KV-legal flat string. */
function flatKey(id: string, suffix: string | number): string {
  return `${id}/${suffix}`;
}

/** Parse the user's input into Uint8Array + sniffed mime + size. */
async function materializeBlob(
  input: ArtifactDataInput,
): Promise<{ bytes: Uint8Array; mimeType: string; originalName?: string }> {
  let bytes: Uint8Array;
  if (input.content instanceof Uint8Array) {
    bytes = input.content;
  } else if (input.contentEncoding === "base64") {
    bytes = base64Decode(input.content);
  } else {
    bytes = new TextEncoder().encode(input.content);
  }

  // Mime override wins (rarely needed); otherwise sniff from magic
  // bytes; otherwise fall back to octet-stream.
  let mimeType: string;
  if (input.mimeType) {
    mimeType = input.mimeType;
  } else {
    const sniffed = await fileTypeFromBuffer(bytes);
    mimeType = sniffed?.mime ?? "application/octet-stream";
  }

  return { bytes, mimeType, ...(input.originalName ? { originalName: input.originalName } : {}) };
}

function base64Decode(s: string): Uint8Array {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer to satisfy WebCrypto's BufferSource
  // typing (which rejects ArrayBufferLike-backed Uint8Array).
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return encodeHex(new Uint8Array(digest));
}

function toSummary(a: Artifact): ArtifactSummary {
  const { data, ...rest } = a;
  return {
    ...rest,
    mimeType: data.mimeType,
    size: data.size,
    ...(data.originalName ? { originalName: data.originalName } : {}),
  };
}

export class JetStreamArtifactStorageAdapter implements ArtifactStorageAdapter {
  private cachedKv: KV | null = null;
  private cachedOs: ObjectStore | null = null;

  constructor(private readonly nc: NatsConnection) {}

  private async kv(): Promise<KV> {
    if (this.cachedKv) return this.cachedKv;
    const js = this.nc.jetstream();
    this.cachedKv = await js.views.kv(KV_BUCKET, { history: HISTORY });
    return this.cachedKv;
  }

  private async os(): Promise<ObjectStore> {
    if (this.cachedOs) return this.cachedOs;
    const js = this.nc.jetstream();
    this.cachedOs = await js.views.os(OS_BUCKET);
    return this.cachedOs;
  }

  /**
   * Write blob bytes to Object Store, named by sha256. Idempotent —
   * if an object with the same name already exists, skip the write.
   *
   * NB: `os.info()` returns `null` for missing entries; it does NOT
   * throw. The earlier `try { await os.info() } catch {}` shape always
   * fell into the early-return branch, silently skipping every put.
   */
  private async putBlob(bytes: Uint8Array, contentRef: string): Promise<void> {
    const os = await this.os();
    const existing = await os.info(contentRef);
    if (existing) return; // already present — content-addressed, so identical bytes
    await os.put({ name: contentRef }, readableFrom(bytes));
  }

  private async readMeta(id: string, revision: number): Promise<Artifact | null> {
    const kv = await this.kv();
    const entry = await kv.get(flatKey(id, revision));
    if (!entry || entry.operation !== "PUT") return null;
    return ArtifactSchema.parse(JSON.parse(dec.decode(entry.value)));
  }

  private async readLatestRevision(id: string): Promise<number | null> {
    const kv = await this.kv();
    const entry = await kv.get(flatKey(id, SUFFIX_LATEST));
    if (!entry || entry.operation !== "PUT") return null;
    return Number(dec.decode(entry.value));
  }

  private async writeMeta(artifact: Artifact): Promise<void> {
    const kv = await this.kv();
    const json = JSON.stringify(artifact);
    await kv.put(flatKey(artifact.id, artifact.revision), enc.encode(json));
    // _latest write happens via CAS to handle concurrent updates.
    for (let attempt = 0; attempt < 8; attempt++) {
      const existing = await kv.get(flatKey(artifact.id, SUFFIX_LATEST));
      const currentLatest =
        existing && existing.operation === "PUT" ? Number(dec.decode(existing.value)) : 0;
      if (artifact.revision <= currentLatest) return; // someone wrote a newer one already
      try {
        if (!existing || existing.operation !== "PUT") {
          await kv.create(
            flatKey(artifact.id, SUFFIX_LATEST),
            enc.encode(String(artifact.revision)),
          );
        } else {
          await kv.update(
            flatKey(artifact.id, SUFFIX_LATEST),
            enc.encode(String(artifact.revision)),
            existing.revision,
          );
        }
        return;
      } catch (err) {
        if (isCASConflict(err) && attempt < 7) continue;
        throw err;
      }
    }
    throw new Error(`Failed to update _latest for artifact ${artifact.id} after CAS retries`);
  }

  private async isDeleted(id: string): Promise<boolean> {
    const kv = await this.kv();
    const entry = await kv.get(flatKey(id, SUFFIX_DELETED));
    return Boolean(entry && entry.operation === "PUT");
  }

  async create(input: CreateArtifactInput): Promise<Result<Artifact, string>> {
    try {
      const { bytes, mimeType, originalName } = await materializeBlob(input.data);
      const contentRef = await sha256Hex(bytes);
      await this.putBlob(bytes, contentRef);

      const id = crypto.randomUUID();
      const artifact: Artifact = {
        id,
        type: "file",
        revision: 1,
        data: {
          type: "file",
          contentRef,
          size: bytes.byteLength,
          mimeType,
          ...(originalName ? { originalName } : {}),
        },
        title: input.title,
        summary: input.summary,
        createdAt: new Date().toISOString(),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.chatId ? { chatId: input.chatId } : {}),
        ...(input.slug ? { slug: input.slug } : {}),
        ...(input.source ? { source: input.source } : {}),
      };

      await this.writeMeta(artifact);
      return success(artifact);
    } catch (err) {
      logger.error("Failed to create artifact", { error: stringifyError(err) });
      return fail(stringifyError(err));
    }
  }

  async update(input: {
    id: string;
    data: ArtifactDataInput;
    title?: string;
    summary: string;
    revisionMessage?: string;
  }): Promise<Result<Artifact, string>> {
    try {
      if (await this.isDeleted(input.id)) {
        return fail(`Artifact ${input.id} has been deleted`);
      }
      const latest = await this.readLatestRevision(input.id);
      if (latest === null) return fail(`Artifact ${input.id} not found`);
      const current = await this.readMeta(input.id, latest);
      if (!current) return fail(`Artifact ${input.id} revision ${latest} not found`);

      const { bytes, mimeType, originalName } = await materializeBlob(input.data);
      const contentRef = await sha256Hex(bytes);
      await this.putBlob(bytes, contentRef);

      const next: Artifact = {
        ...current,
        revision: latest + 1,
        data: {
          type: "file",
          contentRef,
          size: bytes.byteLength,
          mimeType,
          ...(originalName ? { originalName } : {}),
        },
        title: input.title ?? current.title,
        summary: input.summary,
        createdAt: new Date().toISOString(),
        ...(input.revisionMessage ? { revisionMessage: input.revisionMessage } : {}),
      };

      await this.writeMeta(next);
      return success(next);
    } catch (err) {
      return fail(stringifyError(err));
    }
  }

  async get(input: { id: string; revision?: number }): Promise<Result<Artifact | null, string>> {
    try {
      if (await this.isDeleted(input.id)) return success(null);
      const revision = input.revision ?? (await this.readLatestRevision(input.id));
      if (revision === null) return success(null);
      const meta = await this.readMeta(input.id, revision);
      return success(meta);
    } catch (err) {
      return fail(stringifyError(err));
    }
  }

  async deleteArtifact(input: { id: string }): Promise<Result<void, string>> {
    try {
      const kv = await this.kv();
      await kv.put(flatKey(input.id, SUFFIX_DELETED), enc.encode(new Date().toISOString()));
      return success(undefined);
    } catch (err) {
      return fail(stringifyError(err));
    }
  }

  async getManyLatest(input: { ids: string[] }): Promise<Result<Artifact[], string>> {
    try {
      const out: Artifact[] = [];
      for (const id of input.ids) {
        const got = await this.get({ id });
        if (got.ok && got.data) out.push(got.data);
      }
      return success(out);
    } catch (err) {
      return fail(stringifyError(err));
    }
  }

  listAll(input: {
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>> {
    return this.listFiltered(() => true, input.limit ?? 100);
  }

  listByWorkspace(input: {
    workspaceId: string;
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>> {
    return this.listFiltered((a) => a.workspaceId === input.workspaceId, input.limit ?? 100);
  }

  listByChat(input: {
    chatId: string;
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>> {
    return this.listFiltered((a) => a.chatId === input.chatId, input.limit ?? 100);
  }

  /**
   * Common list path: walk the KV's _latest pointers, fetch each
   * latest-revision metadata, filter, sort by createdAt desc, slice.
   * No secondary index — at expected cardinality (low thousands max),
   * the keys() scan + per-key gets are sub-second. If artifacts grow
   * to tens of thousands per workspace, add `ARTIFACTS_BY_WORKSPACE`
   * + `ARTIFACTS_BY_CHAT` indices then.
   */
  private async listFiltered(
    pred: (a: Artifact) => boolean,
    limit: number,
  ): Promise<Result<ArtifactSummary[], string>> {
    try {
      const kv = await this.kv();
      const it = await kv.keys();
      const latestKeys: string[] = [];
      for await (const k of it) {
        if (k.endsWith(`/${SUFFIX_LATEST}`)) latestKeys.push(k);
      }
      const out: Artifact[] = [];
      for (const latestKey of latestKeys) {
        const id = latestKey.slice(0, -`/${SUFFIX_LATEST}`.length);
        if (await this.isDeleted(id)) continue;
        const got = await this.get({ id });
        if (got.ok && got.data && pred(got.data)) out.push(got.data);
      }
      out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return success(out.slice(0, limit).map(toSummary));
    } catch (err) {
      return fail(stringifyError(err));
    }
  }

  /**
   * Read text contents (UTF-8 decode of the blob). Suitable for
   * text/csv/json/markdown artifacts. Binary artifacts return
   * garbled text — prefer `readBinaryContents` for those.
   */
  async readFileContents(input: {
    id: string;
    revision?: number;
  }): Promise<Result<string, string>> {
    const bytes = await this.readBinaryContents(input);
    if (!bytes.ok) return bytes;
    return success(new TextDecoder().decode(bytes.data));
  }

  async readBinaryContents(input: {
    id: string;
    revision?: number;
  }): Promise<Result<Uint8Array, string>> {
    try {
      const got = await this.get(input);
      if (!got.ok) return got;
      if (!got.data) return fail("Artifact not found");
      const os = await this.os();
      const result = await os.get(got.data.data.contentRef);
      if (!result) return fail(`Object Store entry missing for ${got.data.data.contentRef}`);
      const reader = result.data.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      // biome-ignore lint/correctness/noUnreachable: typed loop break
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
      }
      return success(out);
    } catch (err) {
      return fail(stringifyError(err));
    }
  }
}

/** Wrap a Uint8Array as a ReadableStream<Uint8Array> for Object Store put. */
function readableFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
