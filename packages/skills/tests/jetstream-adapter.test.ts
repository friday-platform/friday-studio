/**
 * Smoke tests for `JetStreamSkillAdapter`. Mirrors the shape of the
 * `LocalSkillAdapter` tests at the contract level — publish + read +
 * version listing + assignments + archive round-trip.
 *
 * Full behavioral parity coverage stays in the LocalSkillAdapter
 * suite; this file exercises just enough of the JetStream path to
 * catch a regression in the encoding layer or KV/OS wiring.
 */

import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JetStreamSkillAdapter } from "../src/jetstream-adapter.ts";

let server: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

describe("JetStreamSkillAdapter", () => {
  it("publishes a new skill at version 1 and reads it back", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    const result = await adapter.publish("user", "first-skill", "alice", {
      description: "first skill",
      instructions: "do the thing",
    });
    expect(result.ok).toBe(true);
    expect.assert(result.ok === true);
    expect(result.data.version).toBe(1);

    const got = await adapter.get("user", "first-skill");
    expect(got.ok).toBe(true);
    expect.assert(got.ok === true);
    expect(got.data?.description).toBe("first skill");
    expect(got.data?.version).toBe(1);
  });

  it("subsequent publish increments version", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    await adapter.publish("user", "second-skill", "alice", {
      description: "v1",
      instructions: "v1 instructions",
    });
    const v2 = await adapter.publish("user", "second-skill", "alice", {
      description: "v2",
      instructions: "v2 instructions",
    });
    expect.assert(v2.ok === true);
    expect(v2.data.version).toBe(2);

    const versions = await adapter.listVersions("user", "second-skill");
    expect.assert(versions.ok === true);
    expect(versions.data.map((v) => v.version)).toEqual([2, 1]);
  });

  it("archives round-trip through Object Store", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    const archive = new Uint8Array([1, 2, 3, 4, 5]);
    const result = await adapter.publish("user", "archived-skill", "alice", {
      description: "with archive",
      instructions: "ins",
      archive,
    });
    expect.assert(result.ok === true);
    const got = await adapter.get("user", "archived-skill");
    expect.assert(got.ok === true);
    expect(got.data?.archive).not.toBeNull();
    expect(Array.from(got.data?.archive ?? [])).toEqual([1, 2, 3, 4, 5]);
  });

  it("preserves archive across versions when publish omits it", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    await adapter.publish("user", "carried-skill", "alice", {
      description: "v1",
      instructions: "ins",
      archive: new Uint8Array([9, 9, 9]),
    });
    const v2 = await adapter.publish("user", "carried-skill", "alice", {
      description: "v2",
      instructions: "v2 ins",
    });
    expect.assert(v2.ok === true);

    const got = await adapter.get("user", "carried-skill");
    expect.assert(got.ok === true);
    expect(Array.from(got.data?.archive ?? [])).toEqual([9, 9, 9]);
  });

  it("list filters drafts (name=null) and disabled rows by default", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    await adapter.create("user", "alice"); // draft, no name
    await adapter.publish("user", "visible-skill", "alice", {
      description: "published",
      instructions: "ins",
    });
    const disabled = await adapter.publish("user", "hidden-skill", "alice", {
      description: "to be disabled",
      instructions: "ins",
    });
    expect.assert(disabled.ok === true);
    await adapter.setDisabled(disabled.data.skillId, true);

    const list = await adapter.list("user");
    expect.assert(list.ok === true);
    const names = list.data.map((s) => s.name);
    expect(names).toContain("visible-skill");
    expect(names).not.toContain("hidden-skill");
    expect(names).not.toContain(null);
  });

  it("workspace-level + job-level assignments are isolated", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    const a = await adapter.publish("user", "ws-skill", "alice", {
      description: "ws",
      instructions: "i",
    });
    const b = await adapter.publish("user", "job-skill", "alice", {
      description: "job",
      instructions: "i",
    });
    expect.assert(a.ok === true);
    expect.assert(b.ok === true);

    await adapter.assignSkill(a.data.skillId, "ws-1");
    await adapter.assignToJob(b.data.skillId, "ws-1", "job-a");

    const wsList = await adapter.listAssigned("ws-1");
    expect.assert(wsList.ok === true);
    expect(wsList.data.map((s) => s.name)).toEqual(["ws-skill"]);

    const jobList = await adapter.listAssignmentsForJob("ws-1", "job-a");
    expect.assert(jobList.ok === true);
    expect(jobList.data.map((s) => s.name)).toEqual(["job-skill"]);

    const jobOnly = await adapter.listJobOnlySkillIds();
    expect.assert(jobOnly.ok === true);
    expect(jobOnly.data).toContain(b.data.skillId);
    expect(jobOnly.data).not.toContain(a.data.skillId);
  });

  it("deleteSkill removes all versions, assignments, and indexes", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    const r = await adapter.publish("user", "ephemeral-skill", "alice", {
      description: "go away",
      instructions: "i",
    });
    expect.assert(r.ok === true);
    await adapter.assignSkill(r.data.skillId, "ws-x");

    const before = await adapter.get("user", "ephemeral-skill");
    expect.assert(before.ok === true);
    expect(before.data).not.toBeNull();

    await adapter.deleteSkill(r.data.skillId);

    const after = await adapter.get("user", "ephemeral-skill");
    expect.assert(after.ok === true);
    expect(after.data).toBeNull();

    const assignments = await adapter.listAssigned("ws-x");
    expect.assert(assignments.ok === true);
    expect(assignments.data.find((s) => s.skillId === r.data.skillId)).toBeUndefined();
  });
});
