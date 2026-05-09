/**
 * Smoke tests for `JetStreamSkillAdapter` — the only production
 * skill storage adapter. Covers publish + read + version listing +
 * archive round-trip + assignments + delete.
 */

import { createJetStreamKVStorage } from "@atlas/storage";
import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JetStreamSkillAdapter, type SkillRecord } from "../src/jetstream-adapter.ts";

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

  it("propagates user-invocable frontmatter into SkillSummary.userInvocable", async () => {
    const adapter = new JetStreamSkillAdapter(nc);

    const hidden = await adapter.publish("user", "hidden-system-skill", "alice", {
      description: "runtime composes this",
      instructions: "ins",
      frontmatter: { "user-invocable": false },
    });
    expect.assert(hidden.ok === true);

    const visible = await adapter.publish("user", "visible-author-skill", "alice", {
      description: "regular skill",
      instructions: "ins",
      frontmatter: { "user-invocable": true },
    });
    expect.assert(visible.ok === true);

    const defaultFlag = await adapter.publish("user", "default-flag-skill", "alice", {
      description: "no frontmatter flag",
      instructions: "ins",
    });
    expect.assert(defaultFlag.ok === true);

    const list = await adapter.list("user");
    expect.assert(list.ok === true);
    const byName = new Map(list.data.map((s) => [s.name, s]));
    expect(byName.get("hidden-system-skill")?.userInvocable).toBe(false);
    expect(byName.get("visible-author-skill")?.userInvocable).toBe(true);
    expect(byName.get("default-flag-skill")?.userInvocable).toBe(true);

    // Direct `get(namespace, name)` returns the skill regardless of the flag —
    // the runtime relies on this for `composeValidationBlock` to load the body.
    const direct = await adapter.get("user", "hidden-system-skill");
    expect.assert(direct.ok === true);
    expect(direct.data?.name).toBe("hidden-system-skill");
    expect(direct.data?.frontmatter["user-invocable"]).toBe(false);
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

describe("JetStreamSkillAdapter.replayVersion", () => {
  // Each test uses a unique skillId so we can `listVersions(ns, name)` against
  // skills that publish() never wrote (replay does not maintain the by_name
  // index — that's the migration/bundle caller's job once per skill).
  function buildRecord(overrides: Partial<SkillRecord> & Pick<SkillRecord, "skillId">): SkillRecord {
    return {
      id: overrides.id ?? `id-${overrides.skillId}-${overrides.version ?? 1}`,
      skillId: overrides.skillId,
      namespace: overrides.namespace ?? "user",
      name: overrides.name ?? `replay-${overrides.skillId}`,
      version: overrides.version ?? 1,
      description: overrides.description ?? "replayed skill",
      descriptionManual: overrides.descriptionManual ?? false,
      disabled: overrides.disabled ?? false,
      frontmatter: overrides.frontmatter ?? {},
      instructions: overrides.instructions ?? "ins",
      hasArchive: overrides.hasArchive ?? false,
      createdBy: overrides.createdBy ?? "alice",
      createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    };
  }

  // Replay does NOT write the by_name index, so `listVersions(ns, name)` —
  // which resolves via by_name first — won't see replayed-only skills. Tests
  // that need it set the index manually, mirroring what the migration/bundle
  // caller will do after the per-skill replay loop.
  async function setByNameIndex(
    nc: NatsConnection,
    namespace: string,
    name: string,
    skillId: string,
  ): Promise<void> {
    const kv = await createJetStreamKVStorage(nc, { bucket: "SKILLS", history: 1 });
    await kv.set<string>(["index", "by_name", namespace, name], skillId);
  }

  it("replays a record verbatim — version/id/createdAt/archive all honored", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    const skillId = "replay-happy-skill";
    const archive = new Uint8Array([10, 20, 30, 40]);
    const record = buildRecord({
      id: "custom-id-happy",
      skillId,
      name: "happy-replay",
      version: 5,
      description: "v5",
      createdAt: "2025-06-15T12:34:56.000Z",
    });

    const result = await adapter.replayVersion(record, archive);
    expect.assert(result.ok === true);

    await setByNameIndex(nc, "user", "happy-replay", skillId);

    const byId = await adapter.getById("custom-id-happy");
    expect.assert(byId.ok === true);
    expect(byId.data?.skillId).toBe(skillId);
    expect(byId.data?.version).toBe(5);
    expect(byId.data?.createdAt.toISOString()).toBe("2025-06-15T12:34:56.000Z");

    const versions = await adapter.listVersions("user", "happy-replay");
    expect.assert(versions.ok === true);
    expect(versions.data.map((v) => v.version)).toContain(5);

    const bySkill = await adapter.getBySkillId(skillId);
    expect.assert(bySkill.ok === true);
    expect(bySkill.data?.version).toBe(5);
    expect(Array.from(bySkill.data?.archive ?? [])).toEqual([10, 20, 30, 40]);
  });

  it("preserves version gaps — replaying [1, 3, 5] yields listVersions desc [5, 3, 1]", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    const skillId = "replay-gaps-skill";
    for (const version of [1, 3, 5]) {
      const r = await adapter.replayVersion(
        buildRecord({ id: `gap-${version}`, skillId, name: "gap-replay", version }),
      );
      expect.assert(r.ok === true);
    }
    await setByNameIndex(nc, "user", "gap-replay", skillId);

    const versions = await adapter.listVersions("user", "gap-replay");
    expect.assert(versions.ok === true);
    expect(versions.data.map((v) => v.version)).toEqual([5, 3, 1]);
  });

  it("omitting archive bytes leaves the version archive-less", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    const skillId = "replay-noarchive-skill";
    const r = await adapter.replayVersion(
      buildRecord({ id: "noarch-1", skillId, name: "noarchive-replay" }),
    );
    expect.assert(r.ok === true);

    const got = await adapter.getBySkillId(skillId);
    expect.assert(got.ok === true);
    expect(got.data?.archive).toBeNull();
  });

  it("rejects duplicate replay at the same (skillId, version)", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    const skillId = "replay-dup-skill";
    const first = await adapter.replayVersion(
      buildRecord({ id: "dup-1", skillId, name: "dup-replay" }),
    );
    expect.assert(first.ok === true);

    const second = await adapter.replayVersion(
      buildRecord({ id: "dup-1-again", skillId, name: "dup-replay" }),
    );
    expect(second.ok).toBe(false);
    expect.assert(second.ok === false);
    expect(second.error).toContain("already exists");
    expect(second.error).toContain(skillId);
    expect(second.error).toContain("version 1");
  });

  it("preserves disabled=true without a follow-up setDisabled call", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    const skillId = "replay-disabled-skill";
    const r = await adapter.replayVersion(
      buildRecord({ id: "dis-1", skillId, name: "disabled-replay", disabled: true }),
    );
    expect.assert(r.ok === true);

    const got = await adapter.getBySkillId(skillId);
    expect.assert(got.ok === true);
    expect(got.data?.disabled).toBe(true);
  });

  it("preserves an explicit createdAt verbatim", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    const skillId = "replay-date-skill";
    const createdAt = "2026-01-01T00:00:00.000Z";
    const r = await adapter.replayVersion(
      buildRecord({ id: "date-1", skillId, name: "date-replay", createdAt }),
    );
    expect.assert(r.ok === true);

    const got = await adapter.getBySkillId(skillId);
    expect.assert(got.ok === true);
    expect(got.data?.createdAt.toISOString()).toBe(createdAt);
  });
});
