import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@db/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteCommunicatorWiringRepository } from "./sqlite-communicator-wiring-repository.ts";

let dbPath: string;
let repo: SqliteCommunicatorWiringRepository;

beforeEach(() => {
  dbPath = join(tmpdir(), `wiring-test-${randomUUID()}.db`);
  repo = new SqliteCommunicatorWiringRepository(dbPath);
});

afterEach(() => {
  repo.close();
  rmSync(dbPath, { force: true });
});

describe("SqliteCommunicatorWiringRepository", () => {
  it("insert + findByCredentialId roundtrip", async () => {
    await repo.insert("alice", "cred-1", "ws-1", "telegram", "conn-1");
    const found = await repo.findByCredentialId("alice", "cred-1");
    expect(found).toEqual({ workspaceId: "ws-1" });
  });

  it("insert upserts on (user_id, workspace_id, provider) conflict", async () => {
    await repo.insert("alice", "cred-A", "ws-1", "telegram", "conn-A");
    await repo.insert("alice", "cred-B", "ws-1", "telegram", "conn-B");

    // Old credential is gone
    expect(await repo.findByCredentialId("alice", "cred-A")).toBeNull();
    // New credential is wired to the workspace
    expect(await repo.findByCredentialId("alice", "cred-B")).toEqual({ workspaceId: "ws-1" });
    // Lookup by workspace returns the new credential + identifier
    expect(await repo.findByWorkspaceAndProvider("alice", "ws-1", "telegram")).toEqual({
      credentialId: "cred-B",
      identifier: "conn-B",
    });
  });

  it("isolates rows by user_id across every method", async () => {
    await repo.insert("alice", "cred-1", "ws-1", "telegram", "conn-1");

    expect(await repo.findByCredentialId("bob", "cred-1")).toBeNull();
    expect(await repo.findByWorkspaceAndProvider("bob", "ws-1", "telegram")).toBeNull();
    expect(await repo.findByConnectionAndProvider("bob", "conn-1", "telegram")).toBeNull();
    expect(await repo.listWiredWorkspaceIds("bob")).toEqual([]);
    expect(await repo.deleteByWorkspaceAndProvider("bob", "ws-1", "telegram")).toBeNull();

    // bob's deleteByCredentialId leaves alice's row intact
    await repo.deleteByCredentialId("bob", "cred-1");
    expect(await repo.findByCredentialId("alice", "cred-1")).toEqual({ workspaceId: "ws-1" });
  });

  it("deleteByWorkspaceAndProvider returns the deleted credential id, or null", async () => {
    await repo.insert("alice", "cred-1", "ws-1", "telegram", "conn-1");

    const deleted = await repo.deleteByWorkspaceAndProvider("alice", "ws-1", "telegram");
    expect(deleted).toEqual({ credentialId: "cred-1" });
    expect(await repo.findByWorkspaceAndProvider("alice", "ws-1", "telegram")).toBeNull();

    // Second delete returns null
    expect(await repo.deleteByWorkspaceAndProvider("alice", "ws-1", "telegram")).toBeNull();
  });

  it("deleteByCredentialId removes the row", async () => {
    await repo.insert("alice", "cred-1", "ws-1", "telegram", "conn-1");
    await repo.deleteByCredentialId("alice", "cred-1");
    expect(await repo.findByCredentialId("alice", "cred-1")).toBeNull();
  });

  it("listWiredWorkspaceIds returns distinct workspaces for the user", async () => {
    await repo.insert("alice", "cred-1", "ws-1", "telegram", "conn-1");
    await repo.insert("alice", "cred-2", "ws-2", "slack", "conn-2");
    await repo.insert("alice", "cred-3", "ws-1", "slack", "conn-3");

    const ids = await repo.listWiredWorkspaceIds("alice");
    expect(ids.sort()).toEqual(["ws-1", "ws-2"]);
  });

  it("findByConnectionAndProvider matches on connection_id + provider", async () => {
    await repo.insert("alice", "cred-1", "ws-1", "telegram", "conn-1");
    expect(await repo.findByConnectionAndProvider("alice", "conn-1", "telegram")).toEqual({
      workspaceId: "ws-1",
      credentialId: "cred-1",
    });
    // Wrong provider returns null
    expect(await repo.findByConnectionAndProvider("alice", "conn-1", "discord")).toBeNull();
  });

  it("renames legacy 'slack-app' rows to 'slack' on init (idempotent)", async () => {
    // Pre-seed a legacy row by raw INSERT then close, simulating a database
    // produced by the now-deleted OAuth flow at apps/link/src/slack-apps/.
    repo.close();
    const raw = new Database(dbPath);
    raw
      .prepare(
        `INSERT INTO communicator_wiring (id, user_id, credential_id, workspace_id, provider, connection_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-id", "alice", "cred-legacy", "ws-legacy", "slack-app", "conn-legacy");
    raw.close();

    // Re-instantiate against the same db path — constructor runs the rename DDL.
    repo = new SqliteCommunicatorWiringRepository(dbPath);

    // The row is now reachable under provider='slack'.
    expect(await repo.findByWorkspaceAndProvider("alice", "ws-legacy", "slack")).toEqual({
      credentialId: "cred-legacy",
      identifier: "conn-legacy",
    });
    // And no longer under the legacy literal.
    expect(await repo.findByWorkspaceAndProvider("alice", "ws-legacy", "slack-app")).toBeNull();

    // Re-running the constructor again is a no-op.
    repo.close();
    repo = new SqliteCommunicatorWiringRepository(dbPath);
    expect(await repo.findByWorkspaceAndProvider("alice", "ws-legacy", "slack")).toEqual({
      credentialId: "cred-legacy",
      identifier: "conn-legacy",
    });
  });
});
