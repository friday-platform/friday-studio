/**
 * Global vitest setup — one shared NATS test server per worker process.
 *
 * Production daemons require a NATS connection to do anything (every
 * persistence layer is JetStream-backed: chat, memory, skills, document
 * store, artifacts, workspace state, sessions, cron, signals). Tests
 * exercise the same adapters against the same broker — there are no
 * in-process / on-disk fallbacks to silently mask wiring bugs.
 *
 * One nats-server per worker, shared across every suite that runs in
 * that worker. Stream / KV / Object Store buckets are global, so tests
 * that publish to fixed names (e.g. `WORKSPACE_REGISTRY`) share state.
 * Suites that need isolation key their writes by `crypto.randomUUID()`
 * workspace / session / skill ids — the bucket layout already shards
 * many surfaces by workspace so this falls out for free.
 *
 * The shared `NatsConnection` is also exposed via `getTestNc()` for
 * tests that need to construct a JetStream-backed adapter directly
 * instead of going through the singleton facade.
 */

import { initArtifactStorage } from "@atlas/core/artifacts/server";
import { ensureChatsKVBucket, initChatStorage } from "@atlas/core/chat/storage";
import { initMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { initDocumentStore } from "@atlas/document-store";
import { initWorkspaceStateStorage } from "@atlas/mcp-server/state-storage";
import { initSkillStorage } from "@atlas/skills/storage";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll } from "vitest";

let server: TestNatsServer | null = null;
let nc: NatsConnection | null = null;

/** Return the shared NATS connection. Throws if called before beforeAll. */
export function getTestNc(): NatsConnection {
  if (!nc) {
    throw new Error("getTestNc called before vitest beforeAll completed");
  }
  return nc;
}

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  initChatStorage(nc, {});
  await ensureChatsKVBucket(nc);
  initMCPRegistryAdapter(nc);
  initArtifactStorage(nc);
  initDocumentStore(nc);
  initSkillStorage(nc);
  initWorkspaceStateStorage(nc);
}, 60_000);

afterAll(async () => {
  if (nc) await nc.drain();
  if (server) await server.stop();
});
