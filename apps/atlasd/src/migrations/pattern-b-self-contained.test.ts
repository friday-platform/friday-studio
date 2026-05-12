/**
 * Regression guard: migrations that historically reached for the
 * `UserStorage` / `WorkspaceMemberStorage` singleton facades must now
 * be self-contained — i.e. they construct their backends from the `nc`
 * passed via `Migration.run({ nc, logger })`, not from a daemon-side
 * `initUserStorage(nc)` / `initWorkspaceMemberStorage(nc)` call.
 *
 * Why: the standalone CLI `atlas migrate` path (and the installer's
 * pre-launcher invocation that drives it) does not init those facades.
 * Pre-#277 the bug was hidden because compiled binaries enumerated zero
 * migrations; once #277 made the manifest static, every install/upgrade
 * surfaced "UserStorage not initialized" on the first Pattern-B entry.
 *
 * Each case below intentionally skips `initUserStorage` /
 * `initWorkspaceMemberStorage` and asserts the migration completes
 * cleanly. If a future migration is added that reaches for either
 * facade, this test will throw the original error and fail.
 */

import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { UserStorage } from "@atlas/core/users/storage";
import { WorkspaceMemberStorage } from "@atlas/core/workspace-members/storage";
import type { Logger } from "@atlas/logger";
import { createJetStreamFacade } from "jetstream";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migration as provisionUsersBucket } from "./m_20260504_025000_provision_users_bucket.ts";
import { migration as rekeyDefaultUserChats } from "./m_20260504_025500_rekey_default_user_chats.ts";
import { migration as provisionWorkspaceMembers } from "./m_20260511_110800_provision_workspace_members.ts";

let server: TestNatsServer;
let nc: NatsConnection;

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });

  // Pin the regression-guard contract: the facade singletons MUST be
  // uninitialized when this file runs. Today this holds because Vitest's
  // default `pool: "forks"` + `fileParallelism: true` gives each .test.ts
  // file its own worker (so a sibling test's `initUserStorage(nc)` can't
  // leak in). If that config ever flips (e.g. `pool: "threads"` with
  // `isolate: false`), these assertions fail loudly instead of letting
  // the regression guard silently pass against a populated singleton.
  // `getCachedLocalUserId` / `get` both call the internal `b()` guard
  // synchronously before returning, so a null backend throws here
  // regardless of the methods' async return types.
  expect(() => UserStorage.getCachedLocalUserId()).toThrow(/UserStorage not initialized/);
  expect(() => WorkspaceMemberStorage.get("u", "w")).toThrow(
    /WorkspaceMemberStorage not initialized/,
  );
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

async function wipeAllStreams(): Promise<void> {
  const jsm = await nc.jetstreamManager();
  const streams = await jsm.streams.list().next();
  for (const info of streams) {
    try {
      await jsm.streams.delete(info.config.name);
    } catch {
      // best-effort
    }
  }
}

beforeEach(async () => {
  await wipeAllStreams();
});

describe("Pattern-B migrations are self-contained", () => {
  it("provision_users_bucket runs without initUserStorage", async () => {
    const js = createJetStreamFacade(nc);
    await expect(provisionUsersBucket.run({ nc, js, logger: noopLogger })).resolves.toBeUndefined();
  });

  it("rekey_default_user_chats runs without initUserStorage", async () => {
    const js = createJetStreamFacade(nc);
    await expect(
      rekeyDefaultUserChats.run({ nc, js, logger: noopLogger }),
    ).resolves.toBeUndefined();
  });

  it("provision_workspace_members runs without init{User,WorkspaceMember}Storage", async () => {
    const js = createJetStreamFacade(nc);
    await expect(
      provisionWorkspaceMembers.run({ nc, js, logger: noopLogger }),
    ).resolves.toBeUndefined();
  });
});
