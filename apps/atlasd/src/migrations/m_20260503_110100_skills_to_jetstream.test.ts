/**
 * Integration test: SQLite skills.db → JetStream KV/Object Store migration.
 *
 * Spins up a real NATS test server, writes a hand-crafted skills.db fixture
 * matching the pre-PR-#164 schema, runs the migration, and asserts JetStream
 * holds the rows verbatim — `id`, `version`, `createdAt`, and `disabled` all
 * preserved (these were silently lost when the migration used `publish()`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import type { Logger } from "@atlas/logger";
import { JetStreamSkillAdapter } from "@atlas/skills";
import { Database } from "@db/sqlite";
import { createJetStreamFacade } from "jetstream";
import { connect, type NatsConnection } from "nats";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migration } from "./m_20260503_110100_skills_to_jetstream.ts";

let server: TestNatsServer;
let nc: NatsConnection;
let tmpHome: string;
let originalHome: string | undefined;

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

const SCHEMA = `
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  name TEXT,
  version INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  description_manual INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  frontmatter TEXT NOT NULL DEFAULT '{}',
  instructions TEXT NOT NULL DEFAULT '',
  archive BLOB,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(skill_id, version)
);
CREATE TABLE skill_assignments (
  skill_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  job_name TEXT,
  PRIMARY KEY (skill_id, workspace_id, job_name)
);
`;

interface SkillRowFixture {
  id: string;
  skill_id: string;
  namespace: string;
  name: string | null;
  version: number;
  description?: string;
  description_manual?: number;
  disabled?: number;
  frontmatter?: string;
  instructions?: string;
  archive?: Uint8Array | null;
  created_by?: string;
  created_at?: string;
}

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  originalHome = process.env.FRIDAY_HOME;
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
  if (originalHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalHome;
});

afterEach(async () => {
  // Tear down the SKILLS KV bucket and SKILL_ARCHIVES Object Store between
  // tests — otherwise replay-clashes from prior cases poison subsequent runs.
  const facade = createJetStreamFacade(nc);
  await facade.kv.delete("SKILLS");
  await facade.os.delete("SKILL_ARCHIVES");
  if (tmpHome) {
    await rm(tmpHome, { recursive: true, force: true });
  }
});

async function freshHome(): Promise<string> {
  tmpHome = await mkdtemp(join(tmpdir(), "atlas-skills-mig-"));
  process.env.FRIDAY_HOME = tmpHome;
  return tmpHome;
}

function writeSkillsDb(home: string, rows: SkillRowFixture[]): void {
  const db = new Database(join(home, "skills.db"));
  db.exec(SCHEMA);
  const stmt = db.prepare(
    `INSERT INTO skills
       (id, skill_id, namespace, name, version, description, description_manual,
        disabled, frontmatter, instructions, archive, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.id,
      r.skill_id,
      r.namespace,
      r.name,
      r.version,
      r.description ?? "",
      r.description_manual ?? 0,
      r.disabled ?? 0,
      r.frontmatter ?? "{}",
      r.instructions ?? "",
      r.archive ?? null,
      r.created_by ?? "alice",
      r.created_at ?? "2025-12-01T00:00:00.000Z",
    );
  }
  stmt.finalize();
  db.close();
}

describe("m_20260503_110100_skills_to_jetstream", () => {
  it("preserves id, version, createdAt, and disabled verbatim", async () => {
    const home = await freshHome();
    writeSkillsDb(home, [
      {
        id: "ulid-fixed-v1",
        skill_id: "skill-xyz",
        namespace: "user",
        name: "verbatim-skill",
        version: 1,
        description: "v1 desc",
        instructions: "v1 ins",
        created_by: "bob",
        created_at: "2025-09-01T00:00:00.000Z",
      },
      {
        id: "ulid-fixed-v2",
        skill_id: "skill-xyz",
        namespace: "user",
        name: "verbatim-skill",
        version: 2,
        description: "v2 desc",
        instructions: "v2 ins",
        disabled: 1,
        created_by: "bob",
        created_at: "2025-10-15T12:34:56.000Z",
      },
    ]);

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const adapter = new JetStreamSkillAdapter(nc);

    const v1 = await adapter.getById("ulid-fixed-v1");
    expect.assert(v1.ok === true);
    expect(v1.data?.id).toBe("ulid-fixed-v1");
    expect(v1.data?.skillId).toBe("skill-xyz");
    expect(v1.data?.version).toBe(1);
    expect(v1.data?.createdAt.toISOString()).toBe("2025-09-01T00:00:00.000Z");
    expect(v1.data?.disabled).toBe(false);

    const v2 = await adapter.getById("ulid-fixed-v2");
    expect.assert(v2.ok === true);
    expect(v2.data?.id).toBe("ulid-fixed-v2");
    expect(v2.data?.version).toBe(2);
    expect(v2.data?.createdAt.toISOString()).toBe("2025-10-15T12:34:56.000Z");
    expect(v2.data?.disabled).toBe(true);

    const versions = await adapter.listVersions("user", "verbatim-skill");
    expect.assert(versions.ok === true);
    expect(versions.data.map((v) => v.version)).toEqual([2, 1]);
  });

  it("preserves version gaps — source [1, 3, 5] → listVersions [5, 3, 1]", async () => {
    const home = await freshHome();
    writeSkillsDb(
      home,
      [1, 3, 5].map((version) => ({
        id: `gap-${version}`,
        skill_id: "skill-gap",
        namespace: "user",
        name: "gap-skill",
        version,
        instructions: `v${version}`,
        created_at: `2025-12-0${version}T00:00:00.000Z`,
      })),
    );

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const adapter = new JetStreamSkillAdapter(nc);
    const versions = await adapter.listVersions("user", "gap-skill");
    expect.assert(versions.ok === true);
    expect(versions.data.map((v) => v.version)).toEqual([5, 3, 1]);
  });

  it("re-running on already-migrated state is a no-op", async () => {
    const home = await freshHome();
    writeSkillsDb(home, [
      {
        id: "rerun-1",
        skill_id: "skill-rerun",
        namespace: "user",
        name: "rerun-skill",
        version: 1,
        instructions: "v1",
      },
      {
        id: "rerun-2",
        skill_id: "skill-rerun",
        namespace: "user",
        name: "rerun-skill",
        version: 2,
        instructions: "v2",
      },
    ]);

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });
    await migration.run({ nc, js: facade, logger: noopLogger });

    const adapter = new JetStreamSkillAdapter(nc);
    const versions = await adapter.listVersions("user", "rerun-skill");
    expect.assert(versions.ok === true);
    expect(versions.data.map((v) => v.version)).toEqual([2, 1]);

    // ids must be the original SQLite ids, not regenerated ulids.
    const v1 = await adapter.getById("rerun-1");
    expect.assert(v1.ok === true);
    expect(v1.data?.version).toBe(1);
    const v2 = await adapter.getById("rerun-2");
    expect.assert(v2.ok === true);
    expect(v2.data?.version).toBe(2);
  });

  it("round-trips archive bytes through Object Store", async () => {
    const home = await freshHome();
    writeSkillsDb(home, [
      {
        id: "arch-1",
        skill_id: "skill-arch",
        namespace: "user",
        name: "archived-skill",
        version: 1,
        instructions: "ins",
        archive: new Uint8Array([1, 2, 3, 4, 5]),
      },
    ]);

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const adapter = new JetStreamSkillAdapter(nc);
    const got = await adapter.get("user", "archived-skill");
    expect.assert(got.ok === true);
    expect(Array.from(got.data?.archive ?? [])).toEqual([1, 2, 3, 4, 5]);
  });

  it("skips system-bundled (created_by='system') rows", async () => {
    const home = await freshHome();
    writeSkillsDb(home, [
      {
        id: "user-1",
        skill_id: "skill-user",
        namespace: "user",
        name: "user-skill",
        version: 1,
        instructions: "user",
        created_by: "alice",
      },
      {
        id: "system-1",
        skill_id: "skill-system",
        namespace: "friday",
        name: "system-skill",
        version: 1,
        instructions: "system",
        created_by: "system",
      },
    ]);

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const adapter = new JetStreamSkillAdapter(nc);
    const userSkill = await adapter.get("user", "user-skill");
    expect.assert(userSkill.ok === true);
    expect(userSkill.data?.id).toBe("user-1");

    const sysSkill = await adapter.get("friday", "system-skill");
    expect.assert(sysSkill.ok === true);
    expect(sysSkill.data).toBeNull();
  });

  it("drafts (name=null) flow through create() rather than replayVersion", async () => {
    const home = await freshHome();
    writeSkillsDb(home, [
      {
        id: "draft-1",
        skill_id: "skill-draft",
        namespace: "user",
        name: null,
        version: 1,
        instructions: "",
        created_by: "alice",
      },
    ]);

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    // Drafts get a fresh skillId from create() — original draft id is not
    // preserved (replayVersion is for published-version history). Verify a
    // single draft landed in the namespace under list(includeAll=true).
    const adapter = new JetStreamSkillAdapter(nc);
    const all = await adapter.list("user", undefined, true);
    expect.assert(all.ok === true);
    const drafts = all.data.filter((s) => s.name === null);
    expect(drafts).toHaveLength(1);
  });

  it("is a no-op when skills.db does not exist", async () => {
    await freshHome();
    const facade = createJetStreamFacade(nc);
    await expect(migration.run({ nc, js: facade, logger: noopLogger })).resolves.toBeUndefined();
  });

  it("migrates skill_assignments (workspace + job)", async () => {
    const home = await freshHome();
    writeSkillsDb(home, [
      {
        id: "assign-1",
        skill_id: "skill-assigned",
        namespace: "user",
        name: "assigned-skill",
        version: 1,
        description: "x",
        instructions: "x",
      },
    ]);
    const db = new Database(join(home, "skills.db"));
    db.exec(
      `INSERT INTO skill_assignments (skill_id, workspace_id, job_name) VALUES
         ('skill-assigned', 'ws-1', NULL),
         ('skill-assigned', 'ws-1', 'job-a')`,
    );
    db.close();

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    const adapter = new JetStreamSkillAdapter(nc);
    const wsList = await adapter.listAssigned("ws-1");
    expect.assert(wsList.ok === true);
    expect(wsList.data.map((s) => s.name)).toEqual(["assigned-skill"]);

    const jobList = await adapter.listAssignmentsForJob("ws-1", "job-a");
    expect.assert(jobList.ok === true);
    expect(jobList.data.map((s) => s.name)).toEqual(["assigned-skill"]);
  });
});
