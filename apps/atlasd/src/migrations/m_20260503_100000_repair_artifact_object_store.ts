/**
 * One-shot recovery: rehydrate the `artifacts` JetStream Object Store
 * from on-disk legacy artifact files.
 *
 * Why this exists: the original `m_artifacts_to_jetstream` migration
 * (shipped with the artifact redesign) had a bug — it called
 * `await os.info(contentRef)` inside `try/catch`, expecting a throw
 * for "not found". The nats-base-client API actually returns `null`
 * for missing entries (no throw), so the catch was never entered and
 * every `os.put` was silently skipped behind an early `return`. The
 * migration recorded `migratedRevisions: 2090, failed: 0` while
 * writing zero blobs — metadata in JetStream KV pointed at SHA-256
 * names that had no Object Store entries.
 *
 * The fix to the put helper went in alongside this migration. But the
 * legacy `storage.db` was deleted by `drop-legacy-storage-db` after
 * the broken run, so we can't re-walk Deno KV. Instead, we walk the
 * on-disk file directories where legacy artifacts lived (the chat
 * upload root and per-workspace files dirs) and republish each file's
 * bytes to the Object Store under its SHA-256. The KV metadata's
 * `contentRef` is content-addressed by the same hash, so any artifact
 * whose original bytes still exist on disk becomes resolvable again
 * on the next read.
 *
 * Files whose bytes don't match any KV `contentRef` are still
 * uploaded — they're cheap (Object Store dedups by name) and the
 * extra bytes are bounded by the on-disk total. Operator can prune
 * later via `nats object rm artifacts <hash>` if needed.
 *
 * Idempotent: skips entries that already exist in the Object Store.
 * Safe to re-run.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { encodeHex } from "@std/encoding/hex";
import type { Migration } from "jetstream";
import type { ObjectStore } from "nats";

const OS_BUCKET = "artifacts";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
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

async function putIfMissing(
  os: ObjectStore,
  contentRef: string,
  bytes: Uint8Array,
): Promise<"uploaded" | "skipped"> {
  const existing = await os.info(contentRef);
  if (existing) return "skipped";
  await os.put({ name: contentRef }, readableFrom(bytes));
  return "uploaded";
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

export const migration: Migration = {
  // v2: the v1 entry walked uploads/artifacts + workspaces only, missing
  // ~/.atlas/artifacts/<workspaceId> where image-gen + transcription
  // agents wrote their outputs. Bumped slug so the framework re-runs
  // against the broader root set; idempotent on the per-hash check.
  id: "20260503_100000_repair_artifact_object_store",
  name: "rehydrate artifacts Object Store from on-disk files (v2)",
  description:
    "Walk ~/.atlas/uploads/artifacts, ~/.atlas/artifacts/<workspaceId>, and " +
    "~/.atlas/workspaces/<id>/files, hash each file (SHA-256), and republish to " +
    "the `artifacts` JetStream Object Store if not already present. Repairs the " +
    "empty Object Store left by the first artifacts-to-jetstream run, which had " +
    "a bug where os.info()'s null-on-missing return value was misread as " +
    "'present', skipping all puts. v2 adds the missed `~/.atlas/artifacts` root.",
  async run({ nc, logger }) {
    const home = getFridayHome();
    // Three roots covered:
    //   - uploads/artifacts: chat upload route's persisted files
    //   - artifacts/<workspaceId>: image-gen + transcription agent outputs
    //   - workspaces/<id>/files: per-workspace state DBs and other tool output
    const roots = [
      join(home, "uploads", "artifacts"),
      join(home, "artifacts"),
      join(home, "workspaces"),
    ];

    const js = nc.jetstream();
    const os = await js.views.os(OS_BUCKET);

    const counts = { uploaded: 0, skipped: 0, failed: 0, scanned: 0 };

    for (const root of roots) {
      try {
        await stat(root);
      } catch {
        logger.debug("Recovery root not present; skipping", { root });
        continue;
      }

      for await (const filePath of walkFiles(root)) {
        counts.scanned++;
        try {
          const bytes = new Uint8Array(await readFile(filePath));
          const contentRef = await sha256Hex(bytes);
          const result = await putIfMissing(os, contentRef, bytes);
          counts[result]++;
        } catch (err) {
          logger.warn("Failed to rehydrate artifact file", {
            filePath,
            error: stringifyError(err),
          });
          counts.failed++;
        }
      }
    }

    logger.info("Artifact Object Store rehydration complete", counts);
  },
};
