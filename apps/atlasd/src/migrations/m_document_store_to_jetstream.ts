/**
 * Migration: ~/.atlas/workspaces/<wsid>/[sessions/<sid>/]<type>/<id>.json
 * tree → per-workspace JetStream KV bucket `WS_DOCS_<wsid>`.
 *
 * Walks every workspace directory under `~/.atlas/workspaces/`, then for
 * each one:
 *   - workspace-level `<type>/<id>.json` → key ["doc", <type>, <id>]
 *   - workspace-level `_state_<key>.json` → key ["state", <key>]
 *   - session-level `sessions/<sid>/<type>/<id>.json`
 *       → key ["doc", "session", <sid>, <type>, <id>]
 *   - session-level `sessions/<sid>/_state_<key>.json`
 *       → key ["state", "session", <sid>, <key>]
 *
 * Idempotent — uses an `_migrated_v1` marker key per bucket.
 *
 * The `workspaces/<id>/` dir also holds `workspace.yml` and bundle
 * archives (the source-of-truth for workspace config). Those are
 * untouched. Only the document-store JSON files are migrated.
 *
 * No-op if `~/.atlas/workspaces/` doesn't exist or holds no
 * document-store files.
 */

import { join } from "node:path";
import { createJetStreamKVStorage } from "@atlas/storage";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import type { Migration } from "jetstream";

const SAFE_BUCKET_RE = /[^A-Za-z0-9_-]/g;
const MIGRATED_MARKER_KEY = ["_migrated_v1"];
// Top-level entries we KEEP on disk — these are workspace source-of-truth,
// not document-store data. Anything else under workspaces/<id>/ is treated
// as a document type directory.
const NON_DOC_TOP_LEVEL = new Set(["workspace.yml", "workspace.yaml", "bundles"]);

function sanitizeBucketName(workspaceId: string): string {
  return workspaceId.replace(SAFE_BUCKET_RE, "_");
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    const content = await Deno.readTextFile(path);
    if (!content.trim()) return null;
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export const m_document_store_to_jetstream: Migration = {
  id: "document-store-to-jetstream",
  name: "FileSystemDocumentStore → per-workspace JetStream KV",
  description:
    "Walk ~/.atlas/workspaces/<wsid>/ and copy every document-store " +
    "JSON file (workspace docs, workspace state, session docs, session " +
    "state) into the per-workspace WS_DOCS_<wsid> JetStream KV bucket. " +
    "workspace.yml and bundles/ are left untouched. Idempotent via a " +
    "_migrated_v1 marker key per bucket. Source files left in place " +
    "for rollback.",
  async run({ nc, logger }) {
    const workspacesRoot = join(getFridayHome(), "workspaces");

    let workspaceDirs: string[];
    try {
      workspaceDirs = [];
      for await (const entry of Deno.readDir(workspacesRoot)) {
        if (entry.isDirectory) workspaceDirs.push(entry.name);
      }
    } catch {
      logger.debug("No legacy workspaces dir — nothing to migrate", { path: workspacesRoot });
      return;
    }

    let workspacesProcessed = 0;
    let workspacesSkipped = 0;
    let totalDocs = 0;

    for (const workspaceId of workspaceDirs) {
      const wsRoot = join(workspacesRoot, workspaceId);
      const bucket = `WS_DOCS_${sanitizeBucketName(workspaceId)}`;
      const targetStorage = await createJetStreamKVStorage(nc, { bucket, history: 1 });

      const marker = await targetStorage.get<{ at: string }>(MIGRATED_MARKER_KEY);
      if (marker) {
        workspacesSkipped++;
        logger.debug("Workspace docs already migrated", { workspaceId, bucket });
        continue;
      }

      let migratedThisWs = 0;

      // Workspace-level: <type>/<id>.json + _state_<key>.json
      try {
        for await (const entry of Deno.readDir(wsRoot)) {
          if (NON_DOC_TOP_LEVEL.has(entry.name)) continue;
          if (entry.name === "sessions") continue; // handled below

          if (entry.isFile) {
            const stateMatch = entry.name.match(/^_state_(.+)\.json$/);
            if (stateMatch) {
              const key = stateMatch[1];
              const value = await readJsonFile(join(wsRoot, entry.name));
              if (value !== null && key) {
                await targetStorage.set(["state", key], value);
                migratedThisWs++;
              }
            }
            continue;
          }

          if (entry.isDirectory) {
            const type = entry.name;
            const typeDir = join(wsRoot, type);
            for await (const fileEntry of Deno.readDir(typeDir)) {
              if (!fileEntry.isFile || !fileEntry.name.endsWith(".json")) continue;
              const id = fileEntry.name.replace(/\.json$/, "");
              const value = await readJsonFile(join(typeDir, fileEntry.name));
              if (value !== null) {
                await targetStorage.set(["doc", type, id], value);
                migratedThisWs++;
              }
            }
          }
        }
      } catch (err) {
        logger.warn("Workspace doc walk failed", { workspaceId, error: stringifyError(err) });
      }

      // Session-level: sessions/<sid>/<type>/<id>.json + _state_<key>.json
      const sessionsRoot = join(wsRoot, "sessions");
      try {
        for await (const sessionEntry of Deno.readDir(sessionsRoot)) {
          if (!sessionEntry.isDirectory) continue;
          const sessionId = sessionEntry.name;
          const sessionDir = join(sessionsRoot, sessionId);
          for await (const inner of Deno.readDir(sessionDir)) {
            if (inner.isFile) {
              const stateMatch = inner.name.match(/^_state_(.+)\.json$/);
              if (stateMatch) {
                const key = stateMatch[1];
                const value = await readJsonFile(join(sessionDir, inner.name));
                if (value !== null && key) {
                  await targetStorage.set(["state", "session", sessionId, key], value);
                  migratedThisWs++;
                }
              }
              continue;
            }
            if (inner.isDirectory) {
              const type = inner.name;
              const typeDir = join(sessionDir, type);
              for await (const fileEntry of Deno.readDir(typeDir)) {
                if (!fileEntry.isFile || !fileEntry.name.endsWith(".json")) continue;
                const id = fileEntry.name.replace(/\.json$/, "");
                const value = await readJsonFile(join(typeDir, fileEntry.name));
                if (value !== null) {
                  await targetStorage.set(["doc", "session", sessionId, type, id], value);
                  migratedThisWs++;
                }
              }
            }
          }
        }
      } catch {
        // No sessions/ dir — fine.
      }

      await targetStorage.set(MIGRATED_MARKER_KEY, { at: new Date().toISOString() });
      workspacesProcessed++;
      totalDocs += migratedThisWs;
      logger.info("Workspace document store migrated", {
        workspaceId,
        bucket,
        docs: migratedThisWs,
      });
    }

    logger.info("Document store migration complete", {
      workspacesProcessed,
      workspacesSkipped,
      totalDocs,
    });
  },
};
