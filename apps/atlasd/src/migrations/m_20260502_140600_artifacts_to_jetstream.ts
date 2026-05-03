/**
 * Migration: legacy `~/.atlas/storage.db` artifacts → JetStream
 * `ARTIFACTS` KV bucket + `artifacts` Object Store.
 *
 * Step 5 / final step of the Deno KV consolidation, paired with the
 * 2026-05-02 artifact envelope redesign. This is the first migration
 * that moves binary content (not just metadata) into JetStream — each
 * artifact's file is read from disk, hashed, and uploaded to the
 * Object Store under its SHA-256 (so identical bytes across artifacts
 * dedup automatically).
 *
 * Legacy shape (Deno KV):
 *   key   = `["artifact", <id>, <revision>]`
 *           value = full Artifact object with `data.data.path` →
 *           absolute filesystem path
 *   key   = `["artifact_latest", <id>]`
 *           value = revision number
 *   key   = `["artifact_deleted", <id>]`
 *           value = Date (soft-delete tombstone)
 *
 * New shape (JetStream KV `ARTIFACTS`):
 *   key   = `<id>/<revision>` → full Artifact with new `data` shape
 *           `{ type: "file", contentRef, size, mimeType, originalName? }`
 *   key   = `<id>/_latest`    → revision number string
 *   key   = `<id>/_deleted`   → ISO timestamp (soft-delete)
 *
 * The blob content is stored in the `artifacts` Object Store, named by
 * SHA-256 of the bytes. Re-uploads of the same hash are no-ops.
 *
 * Idempotent: a per-artifact `<id>/_latest` check skips already-migrated
 * entries. Missing-on-disk files are logged and skipped (the metadata
 * row is not migrated — better than carrying a broken contentRef).
 *
 * No-op if `storage.db` doesn't exist (fresh install).
 */

import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { encodeHex } from "@std/encoding/hex";
import { typeByExtension } from "@std/media-types";
import { fileTypeFromBuffer } from "file-type";
import { dec, enc, isCASConflict, type Migration } from "jetstream";
import type { KV, ObjectStore } from "nats";

const KV_BUCKET = "ARTIFACTS";
const OS_BUCKET = "artifacts";
const HISTORY = 5;

interface LegacyFileData {
  path: string;
  mimeType?: string;
  originalName?: string;
}

interface LegacyArtifact {
  id: string;
  type: string;
  revision: number;
  data: { type: string; version: number; data: LegacyFileData };
  title: string;
  summary: string;
  workspaceId?: string;
  chatId?: string;
  createdAt: string;
  revisionMessage?: string;
  source?: string;
}

interface NewArtifact {
  id: string;
  type: "file";
  revision: number;
  data: { type: "file"; contentRef: string; size: number; mimeType: string; originalName?: string };
  title: string;
  summary: string;
  workspaceId?: string;
  chatId?: string;
  createdAt: string;
  revisionMessage?: string;
  slug?: string;
  source?: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer to satisfy WebCrypto's typing.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return encodeHex(new Uint8Array(digest));
}

function readableFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function putBlobIdempotent(os: ObjectStore, contentRef: string, bytes: Uint8Array) {
  // os.info() resolves to null when not found — it does NOT throw.
  // Earlier try/catch shape always returned early, silently skipping
  // every put.
  const existing = await os.info(contentRef);
  if (existing) return; // already present (content-addressed)
  await os.put({ name: contentRef }, readableFrom(bytes));
}

async function casUpdateLatest(kv: KV, id: string, revision: number) {
  const latestKey = `${id}/_latest`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = await kv.get(latestKey);
    const currentLatest =
      existing && existing.operation === "PUT" ? Number(dec.decode(existing.value)) : 0;
    if (revision <= currentLatest) return;
    try {
      if (!existing || existing.operation !== "PUT") {
        await kv.create(latestKey, enc.encode(String(revision)));
      } else {
        await kv.update(latestKey, enc.encode(String(revision)), existing.revision);
      }
      return;
    } catch (err) {
      if (isCASConflict(err) && attempt < 7) continue;
      throw err;
    }
  }
  throw new Error(`Failed CAS update for ${latestKey}`);
}

export const migration: Migration = {
  id: "20260502_140600_artifacts_to_jetstream",
  name: "artifacts → JetStream KV + Object Store",
  description:
    "Walk ~/.atlas/storage.db artifact rows, read each revision's file from disk, " +
    "hash the bytes (SHA-256), upload to the `artifacts` Object Store, and write " +
    "metadata rows under the new `<id>/<revision>`/`<id>/_latest`/`<id>/_deleted` " +
    "shape into the ARTIFACTS JetStream KV bucket. The new envelope drops the " +
    "filesystem path (replaced by the SHA-256 contentRef), drops the never-branched " +
    "`version: 1` literal, and flattens the triple-`data`-nesting. Idempotent. " +
    "Files missing on disk are logged and skipped.",
  async run({ nc, logger: parentLogger }) {
    const logger = parentLogger ?? createLogger({ name: "m_artifacts_to_jetstream" });
    const legacyPath = join(getFridayHome(), "storage.db");

    try {
      await stat(legacyPath);
    } catch {
      logger.debug("Legacy storage.db not present — nothing to migrate", { path: legacyPath });
      return;
    }

    const denoKv: Deno.Kv = await Deno.openKv(legacyPath);
    try {
      const js = nc.jetstream();
      const kv = await js.views.kv(KV_BUCKET, { history: HISTORY });
      const os = await js.views.os(OS_BUCKET);

      let migratedRevisions = 0;
      let migratedDeletes = 0;
      let skipped = 0;
      let missingFiles = 0;
      let failed = 0;

      // --- Walk all revisions ---
      for await (const entry of denoKv.list<LegacyArtifact>({ prefix: ["artifact"] })) {
        const key = entry.key;
        if (key.length !== 3 || key[0] !== "artifact") continue; // only ["artifact", id, rev]
        const id = key[1] as string;
        const revision = Number(key[2]);
        if (!id || !Number.isFinite(revision)) continue;

        // Skip if this exact revision is already in the new bucket.
        const existing = await kv.get(`${id}/${revision}`);
        if (existing && existing.operation === "PUT") {
          skipped++;
          continue;
        }

        const legacy = entry.value;
        if (!legacy || legacy.data?.type !== "file" || !legacy.data?.data?.path) {
          logger.warn("Skipping malformed legacy artifact row", { id, revision });
          continue;
        }

        const filePath = legacy.data.data.path;
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await readFile(filePath));
        } catch (err) {
          logger.warn("Legacy artifact file missing on disk; skipping revision", {
            id,
            revision,
            filePath,
            error: stringifyError(err),
          });
          missingFiles++;
          continue;
        }

        try {
          const contentRef = await sha256Hex(bytes);
          await putBlobIdempotent(os, contentRef, bytes);

          // Resolve mime: prefer legacy mimeType, fall back to extension,
          // then to magic-byte sniff, then octet-stream.
          let mimeType = legacy.data.data.mimeType;
          if (!mimeType) {
            const ext = extname(filePath);
            mimeType = typeByExtension(ext) ?? "";
          }
          if (!mimeType) {
            const sniffed = await fileTypeFromBuffer(bytes);
            mimeType = sniffed?.mime ?? "application/octet-stream";
          }

          const next: NewArtifact = {
            id: legacy.id,
            type: "file",
            revision: legacy.revision,
            data: {
              type: "file",
              contentRef,
              size: bytes.byteLength,
              mimeType,
              ...(legacy.data.data.originalName
                ? { originalName: legacy.data.data.originalName }
                : {}),
            },
            title: legacy.title,
            summary: legacy.summary,
            createdAt: legacy.createdAt,
            ...(legacy.workspaceId ? { workspaceId: legacy.workspaceId } : {}),
            ...(legacy.chatId ? { chatId: legacy.chatId } : {}),
            ...(legacy.revisionMessage ? { revisionMessage: legacy.revisionMessage } : {}),
            ...(legacy.source ? { source: legacy.source } : {}),
          };

          await kv.put(`${id}/${revision}`, enc.encode(JSON.stringify(next)));
          migratedRevisions++;
        } catch (err) {
          logger.warn("Failed to migrate artifact revision", {
            id,
            revision,
            error: stringifyError(err),
          });
          failed++;
        }
      }

      // --- Apply _latest pointers ---
      for await (const entry of denoKv.list<number>({ prefix: ["artifact_latest"] })) {
        const id = entry.key[1];
        const revision = entry.value;
        if (typeof id !== "string" || typeof revision !== "number") continue;
        try {
          await casUpdateLatest(kv, id, revision);
        } catch (err) {
          logger.warn("Failed to set _latest pointer", {
            id,
            revision,
            error: stringifyError(err),
          });
          failed++;
        }
      }

      // --- Apply _deleted tombstones ---
      for await (const entry of denoKv.list<unknown>({ prefix: ["artifact_deleted"] })) {
        const id = entry.key[1];
        if (typeof id !== "string") continue;
        const tombstoneKey = `${id}/_deleted`;
        const existing = await kv.get(tombstoneKey);
        if (existing && existing.operation === "PUT") continue; // already there
        const tsValue =
          entry.value instanceof Date ? entry.value.toISOString() : new Date().toISOString();
        try {
          await kv.put(tombstoneKey, enc.encode(tsValue));
          migratedDeletes++;
        } catch (err) {
          logger.warn("Failed to apply _deleted tombstone", { id, error: stringifyError(err) });
          failed++;
        }
      }

      logger.info("Artifacts migration complete", {
        migratedRevisions,
        migratedDeletes,
        skipped,
        missingFiles,
        failed,
      });
    } finally {
      denoKv.close();
    }
  },
};
