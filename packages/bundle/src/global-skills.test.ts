/**
 * Bundle v2 export/import tests.
 *
 * Most cases drive the real `JetStreamSkillAdapter` via the shared NATS test
 * server in `vitest.setup.ts` — schema v2 round-trips through `replayVersion`,
 * which only the JetStream impl provides. The legacy v1-archive cases use a
 * minimal in-memory `SkillStorageAdapter` shim because the v1 import branch
 * calls only `publish`/`getBySkillId`/`setDisabled` — no `replayVersion`.
 */

import {
  JetStreamSkillAdapter,
  type PublishSkillInput,
  type Skill,
  type SkillReplayer,
  type SkillStorageAdapter,
  type SkillSummary,
  type VersionInfo,
} from "@atlas/skills";
import type { Result } from "@atlas/utils";
import { stringify as stringifyYaml } from "@std/yaml";
import { createJetStreamFacade } from "jetstream";
import JSZip from "jszip";
import type { NatsConnection } from "nats";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getTestNc } from "../../../vitest.setup.ts";
import {
  exportGlobalSkills,
  importGlobalSkills,
  LegacyArchiveError,
  type SkillRowV1,
} from "./global-skills.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Real-NATS harness — v2 round-trip cases
// ──────────────────────────────────────────────────────────────────────────────

let nc: NatsConnection;

beforeAll(() => {
  nc = getTestNc();
});

afterEach(async () => {
  // SKILLS KV + SKILL_ARCHIVES Object Store are global — wipe between tests so
  // replayVersion's duplicate-rejection guard doesn't trip across cases.
  const facade = createJetStreamFacade(nc);
  await facade.kv.delete("SKILLS");
  await facade.os.delete("SKILL_ARCHIVES");
});

async function seedVersion(
  adapter: SkillStorageAdapter,
  args: {
    namespace: string;
    name: string;
    createdBy?: string;
    skillId?: string;
    description?: string;
    instructions?: string;
    archive?: Uint8Array<ArrayBuffer>;
    disabled?: boolean;
  },
): Promise<{ skillId: string; version: number }> {
  const result = await adapter.publish(args.namespace, args.name, args.createdBy ?? "user-1", {
    description: args.description ?? `${args.name} description`,
    instructions: args.instructions ?? "ins",
    ...(args.archive ? { archive: args.archive } : {}),
    ...(args.skillId ? { skillId: args.skillId } : {}),
  });
  if (!result.ok) throw new Error(`seed publish failed: ${result.error}`);
  if (args.disabled === true) {
    const r = await adapter.setDisabled(result.data.skillId, true);
    if (!r.ok) throw new Error(`seed setDisabled failed: ${r.error}`);
  }
  return { skillId: result.data.skillId, version: result.data.version };
}

function bytes(text: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(text);
  const buf = new ArrayBuffer(src.byteLength);
  const out = new Uint8Array(buf);
  out.set(src);
  return out;
}

describe("exportGlobalSkills (v2)", () => {
  it("emits v2 manifest + skills-history.jsonl with one row per (skillId, version)", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    await seedVersion(adapter, { namespace: "user", name: "alpha", instructions: "v1" });
    await seedVersion(adapter, { namespace: "user", name: "alpha", instructions: "v2" });
    await seedVersion(adapter, { namespace: "user", name: "alpha", instructions: "v3" });

    const result = await exportGlobalSkills({ adapter });
    if (!result.bytes) throw new Error("expected bytes");
    expect(result.manifest?.schemaVersion).toBe(2);
    expect(result.manifest?.source.filename).toBe("skills-history.jsonl");
    expect(result.manifest?.source.skillCount).toBe(3);

    const zip = await JSZip.loadAsync(result.bytes);
    const jsonlEntry = zip.file("skills-history.jsonl");
    if (!jsonlEntry) throw new Error("missing skills-history.jsonl");
    const jsonlText = await jsonlEntry.async("string");
    const rows = jsonlText
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { name: string; version: number });
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
  });

  it("filters out skills with createdBy === SYSTEM_USER_ID", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    await seedVersion(adapter, { namespace: "user", name: "user-skill", createdBy: "user-x" });
    await seedVersion(adapter, { namespace: "friday", name: "system-skill", createdBy: "system" });

    const result = await exportGlobalSkills({ adapter });
    if (!result.bytes) throw new Error("expected bytes");
    expect(result.manifest?.source.skillCount).toBe(1);
  });

  it("returns { bytes: null } when only system / no skills are present", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    const empty = await exportGlobalSkills({ adapter });
    expect(empty.bytes).toBeNull();
    expect(empty.manifest).toBeUndefined();

    await seedVersion(adapter, { namespace: "friday", name: "sys", createdBy: "system" });
    const onlySystem = await exportGlobalSkills({ adapter });
    expect(onlySystem.bytes).toBeNull();
  });

  it("classifies archive carry-over as inherited and removal as absent", async () => {
    const adapter = new JetStreamSkillAdapter(nc);
    const a1 = bytes("v1-archive-bytes");
    const a3 = bytes("v3-fresh-bytes");

    // v1: bytes present
    await seedVersion(adapter, { namespace: "user", name: "skill-x", archive: a1 });
    // v2: omit archive → publish() copies prior bytes forward → expected `inherited`.
    await seedVersion(adapter, { namespace: "user", name: "skill-x", instructions: "v2 ins" });
    // v3: replace bytes
    await seedVersion(adapter, { namespace: "user", name: "skill-x", archive: a3 });

    const result = await exportGlobalSkills({ adapter });
    if (!result.bytes) throw new Error("expected bytes");
    const zip = await JSZip.loadAsync(result.bytes);
    const jsonlEntry = zip.file("skills-history.jsonl");
    if (!jsonlEntry) throw new Error("missing skills-history.jsonl");
    const jsonl = await jsonlEntry.async("string");
    const rows = jsonl
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as SkillRowV1 & { archive: { kind: string } });
    expect(rows[0]?.archive.kind).toBe("bytes");
    expect(rows[1]?.archive.kind).toBe("inherited");
    expect(rows[2]?.archive.kind).toBe("bytes");
  });
});

describe("importGlobalSkills (v2 round-trip)", () => {
  it("empty target + multi-version source: imports all 3, idempotent on re-import", async () => {
    const source = new JetStreamSkillAdapter(nc);
    const seeded = await seedVersion(source, { namespace: "user", name: "skill-a" });
    await seedVersion(source, { namespace: "user", name: "skill-a", skillId: seeded.skillId });
    await seedVersion(source, { namespace: "user", name: "skill-a", skillId: seeded.skillId });

    const exported = await exportGlobalSkills({ adapter: source });
    if (!exported.bytes) throw new Error("expected bytes");
    const zipBytes = exported.bytes;

    // Wipe and re-import into a fresh "target" (same broker, fresh state).
    const facade = createJetStreamFacade(nc);
    await facade.kv.delete("SKILLS");
    await facade.os.delete("SKILL_ARCHIVES");

    const target = new JetStreamSkillAdapter(nc);
    const first = await importGlobalSkills({ zipBytes, adapter: target });
    expect(first.status).toEqual({ kind: "imported", skillsPublished: 3, skillsSkipped: 0 });

    const versions = await target.listVersions("user", "skill-a");
    expect(versions.ok).toBe(true);
    if (!versions.ok) return;
    expect(versions.data.map((v) => v.version).sort((a, b) => a - b)).toEqual([1, 2, 3]);

    const second = await importGlobalSkills({ zipBytes, adapter: target });
    expect(second.status).toEqual({ kind: "imported", skillsPublished: 0, skillsSkipped: 3 });
  });

  it("preserves version gaps — source [1, 3, 5] round-trips as [1, 3, 5]", async () => {
    const source = new JetStreamSkillAdapter(nc);
    // Build version chain via replayVersion directly to skip the version-collapse
    // that publish() would impose.
    for (const version of [1, 3, 5]) {
      const r = await source.replayVersion({
        id: `gap-${version}`,
        skillId: "gap-skill",
        namespace: "user",
        name: "gap",
        version,
        description: `v${version}`,
        descriptionManual: false,
        disabled: false,
        frontmatter: {},
        instructions: `ins-${version}`,
        hasArchive: false,
        createdBy: "user-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      if (!r.ok) throw new Error(r.error);
    }

    const exported = await exportGlobalSkills({ adapter: source });
    if (!exported.bytes) throw new Error("expected bytes");
    const zipBytes = exported.bytes;

    const facade = createJetStreamFacade(nc);
    await facade.kv.delete("SKILLS");
    await facade.os.delete("SKILL_ARCHIVES");

    const target = new JetStreamSkillAdapter(nc);
    const result = await importGlobalSkills({ zipBytes, adapter: target });
    expect(result.status.kind).toBe("imported");

    const versions = await target.listVersions("user", "gap");
    if (!versions.ok) throw new Error(versions.error);
    expect(versions.data.map((v) => v.version).sort((a, b) => a - b)).toEqual([1, 3, 5]);
  });

  it("preserves explicit createdAt across round-trip", async () => {
    const source = new JetStreamSkillAdapter(nc);
    const createdAt = "2025-06-15T12:34:56.000Z";
    const r = await source.replayVersion({
      id: "ts-1",
      skillId: "ts-skill",
      namespace: "user",
      name: "ts",
      version: 1,
      description: "v1",
      descriptionManual: false,
      disabled: false,
      frontmatter: {},
      instructions: "ins",
      hasArchive: false,
      createdBy: "user-1",
      createdAt,
    });
    if (!r.ok) throw new Error(r.error);

    const exported = await exportGlobalSkills({ adapter: source });
    if (!exported.bytes) throw new Error("expected bytes");
    const zipBytes = exported.bytes;

    const facade = createJetStreamFacade(nc);
    await facade.kv.delete("SKILLS");
    await facade.os.delete("SKILL_ARCHIVES");

    const target = new JetStreamSkillAdapter(nc);
    const result = await importGlobalSkills({ zipBytes, adapter: target });
    expect(result.status.kind).toBe("imported");

    const got = await target.getBySkillId("ts-skill");
    if (!got.ok || !got.data) throw new Error("missing");
    expect(got.data.createdAt.toISOString()).toBe(createdAt);
  });

  it("archive removal across versions — v2 marked absent stays archive-less", async () => {
    const source = new JetStreamSkillAdapter(nc);
    const v1Bytes = bytes("v1-bytes");
    const v3Bytes = bytes("v3-bytes");
    // v1 has bytes
    await source.replayVersion(
      {
        id: "a-1",
        skillId: "a",
        namespace: "user",
        name: "absent-skill",
        version: 1,
        description: "v1",
        descriptionManual: false,
        disabled: false,
        frontmatter: {},
        instructions: "ins",
        hasArchive: true,
        createdBy: "user-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      v1Bytes,
    );
    // v2 absent
    await source.replayVersion({
      id: "a-2",
      skillId: "a",
      namespace: "user",
      name: "absent-skill",
      version: 2,
      description: "v2",
      descriptionManual: false,
      disabled: false,
      frontmatter: {},
      instructions: "ins",
      hasArchive: false,
      createdBy: "user-1",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    // v3 has new bytes
    await source.replayVersion(
      {
        id: "a-3",
        skillId: "a",
        namespace: "user",
        name: "absent-skill",
        version: 3,
        description: "v3",
        descriptionManual: false,
        disabled: false,
        frontmatter: {},
        instructions: "ins",
        hasArchive: true,
        createdBy: "user-1",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
      v3Bytes,
    );

    const exported = await exportGlobalSkills({ adapter: source });
    if (!exported.bytes) throw new Error("expected bytes");
    const zipBytes = exported.bytes;

    const facade = createJetStreamFacade(nc);
    await facade.kv.delete("SKILLS");
    await facade.os.delete("SKILL_ARCHIVES");

    const target = new JetStreamSkillAdapter(nc);
    const result = await importGlobalSkills({ zipBytes, adapter: target });
    expect(result.status.kind).toBe("imported");

    const v1 = await target.get("user", "absent-skill", 1);
    if (!v1.ok || !v1.data) throw new Error("v1 missing");
    expect(v1.data.archive).not.toBeNull();
    const v2 = await target.get("user", "absent-skill", 2);
    if (!v2.ok || !v2.data) throw new Error("v2 missing");
    expect(v2.data.archive).toBeNull();
    const v3 = await target.get("user", "absent-skill", 3);
    if (!v3.ok || !v3.data) throw new Error("v3 missing");
    expect(v3.data.archive).not.toBeNull();
  });

  it("archive inheritance — v2 marked inherited reuses v1's bytes", async () => {
    const source = new JetStreamSkillAdapter(nc);
    const archiveBytes = bytes("inherited-archive");
    // v1 with bytes; v2 publish without archive → publish() copies forward, exporter classifies as inherited.
    await seedVersion(source, { namespace: "user", name: "inh", archive: archiveBytes });
    await seedVersion(source, { namespace: "user", name: "inh", instructions: "v2" });

    const exported = await exportGlobalSkills({ adapter: source });
    if (!exported.bytes) throw new Error("expected bytes");
    const zipBytes = exported.bytes;

    const facade = createJetStreamFacade(nc);
    await facade.kv.delete("SKILLS");
    await facade.os.delete("SKILL_ARCHIVES");

    const target = new JetStreamSkillAdapter(nc);
    const result = await importGlobalSkills({ zipBytes, adapter: target });
    expect(result.status.kind).toBe("imported");

    const v2 = await target.get("user", "inh", 2);
    if (!v2.ok || !v2.data?.archive) throw new Error("v2 archive missing");
    expect(Array.from(v2.data.archive)).toEqual(Array.from(archiveBytes));
  });

  it("rename across versions — both old and new names resolve same skillId", async () => {
    const source = new JetStreamSkillAdapter(nc);
    await source.replayVersion({
      id: "rn-1",
      skillId: "rn-skill",
      namespace: "user",
      name: "foo",
      version: 1,
      description: "v1",
      descriptionManual: false,
      disabled: false,
      frontmatter: {},
      instructions: "ins",
      hasArchive: false,
      createdBy: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await source.replayVersion({
      id: "rn-2",
      skillId: "rn-skill",
      namespace: "user",
      name: "bar",
      version: 2,
      description: "v2",
      descriptionManual: false,
      disabled: false,
      frontmatter: {},
      instructions: "ins",
      hasArchive: false,
      createdBy: "user-1",
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    const exported = await exportGlobalSkills({ adapter: source });
    if (!exported.bytes) throw new Error("expected bytes");
    const zipBytes = exported.bytes;

    const facade = createJetStreamFacade(nc);
    await facade.kv.delete("SKILLS");
    await facade.os.delete("SKILL_ARCHIVES");

    const target = new JetStreamSkillAdapter(nc);
    const result = await importGlobalSkills({ zipBytes, adapter: target });
    expect(result.status.kind).toBe("imported");

    const fooVersions = await target.listVersions("user", "foo");
    if (!fooVersions.ok) throw new Error(fooVersions.error);
    expect(fooVersions.data.map((v) => v.version).sort()).toEqual([1, 2]);
    const barVersions = await target.listVersions("user", "bar");
    if (!barVersions.ok) throw new Error(barVersions.error);
    expect(barVersions.data.map((v) => v.version).sort()).toEqual([1, 2]);
  });

  it("disabled state preserved on initial import", async () => {
    const source = new JetStreamSkillAdapter(nc);
    await source.replayVersion({
      id: "d-1",
      skillId: "d-skill",
      namespace: "user",
      name: "disabled-skill",
      version: 1,
      description: "v1",
      descriptionManual: false,
      disabled: true,
      frontmatter: {},
      instructions: "ins",
      hasArchive: false,
      createdBy: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const exported = await exportGlobalSkills({ adapter: source });
    if (!exported.bytes) throw new Error("expected bytes");
    const zipBytes = exported.bytes;

    const facade = createJetStreamFacade(nc);
    await facade.kv.delete("SKILLS");
    await facade.os.delete("SKILL_ARCHIVES");

    const target = new JetStreamSkillAdapter(nc);
    const result = await importGlobalSkills({ zipBytes, adapter: target });
    expect(result.status.kind).toBe("imported");

    const got = await target.getBySkillId("d-skill");
    if (!got.ok || !got.data) throw new Error("missing");
    expect(got.data.disabled).toBe(true);
  });

  it("returns integrity-failed when manifest sha doesn't match jsonl bytes", async () => {
    const source = new JetStreamSkillAdapter(nc);
    await seedVersion(source, { namespace: "user", name: "intg" });
    const exported = await exportGlobalSkills({ adapter: source });
    if (!exported.bytes) throw new Error("expected bytes");

    // Tamper: append a newline to skills-history.jsonl, leave manifest untouched.
    const zip = await JSZip.loadAsync(exported.bytes);
    const jsonlEntry = zip.file("skills-history.jsonl");
    if (!jsonlEntry) throw new Error("missing skills-history.jsonl");
    const original = await jsonlEntry.async("uint8array");
    const tampered = new Uint8Array(original.byteLength + 1);
    tampered.set(original);
    tampered[original.byteLength] = 0x0a;
    zip.file("skills-history.jsonl", tampered);
    const tamperedZipBytes = await zip.generateAsync({ type: "uint8array" });

    const facade = createJetStreamFacade(nc);
    await facade.kv.delete("SKILLS");
    await facade.os.delete("SKILL_ARCHIVES");

    const target = new JetStreamSkillAdapter(nc);
    const result = await importGlobalSkills({ zipBytes: tamperedZipBytes, adapter: target });
    expect(result.status.kind).toBe("integrity-failed");
    if (result.status.kind !== "integrity-failed") throw new Error("unreachable");
    expect(result.status.expected).not.toBe(result.status.actual);
    expect(result.status.row).toBeUndefined();
  });

  it("returns integrity-failed with row id when archive sha doesn't match", async () => {
    const source = new JetStreamSkillAdapter(nc);
    const seeded = await seedVersion(source, {
      namespace: "user",
      name: "arch",
      archive: bytes("good-archive"),
    });
    const exported = await exportGlobalSkills({ adapter: source });
    if (!exported.bytes) throw new Error("expected bytes");

    const zip = await JSZip.loadAsync(exported.bytes);
    const archivePath = `archives/${seeded.skillId}__${seeded.version}.tar.gz`;
    expect(zip.file(archivePath)).not.toBeNull();
    zip.file(archivePath, new TextEncoder().encode("garbage"));
    const tamperedZipBytes = await zip.generateAsync({ type: "uint8array" });

    const facade = createJetStreamFacade(nc);
    await facade.kv.delete("SKILLS");
    await facade.os.delete("SKILL_ARCHIVES");

    const target = new JetStreamSkillAdapter(nc);
    const result = await importGlobalSkills({ zipBytes: tamperedZipBytes, adapter: target });
    expect(result.status.kind).toBe("integrity-failed");
    if (result.status.kind !== "integrity-failed") throw new Error("unreachable");
    expect(result.status.row).toContain(seeded.skillId);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// v1-archive backwards-compat — uses an in-memory shim because the v1 import
// branch only calls publish/getBySkillId/setDisabled. NO replayVersion lives
// on this shim by design (lead constraint); the v1 path never calls it.
// ──────────────────────────────────────────────────────────────────────────────

interface SeedSkill {
  skillId: string;
  namespace: string;
  name: string;
  version?: number;
  description?: string;
  descriptionManual?: boolean;
  disabled?: boolean;
  frontmatter?: Record<string, unknown>;
  instructions?: string;
  archive?: Uint8Array | null;
  createdBy: string;
  createdAt?: Date;
}

function notImplemented(method: string): never {
  throw new Error(`InMemorySkillAdapter: ${method} not implemented`);
}

class InMemorySkillAdapter implements SkillStorageAdapter {
  private skills = new Map<string, Skill>();
  /** When set, `getBySkillId` returns this Result instead of looking up. */
  public getBySkillIdOverride: Result<Skill | null, string> | null = null;

  seed(seed: SeedSkill): Skill {
    let archive: Uint8Array<ArrayBuffer> | null = null;
    if (seed.archive) {
      const buf = new ArrayBuffer(seed.archive.byteLength);
      archive = new Uint8Array(buf);
      archive.set(seed.archive);
    }
    const skill: Skill = {
      id: `id-${this.skills.size + 1}`,
      skillId: seed.skillId,
      namespace: seed.namespace,
      name: seed.name,
      version: seed.version ?? 1,
      description: seed.description ?? "",
      descriptionManual: seed.descriptionManual ?? false,
      disabled: seed.disabled ?? false,
      frontmatter: seed.frontmatter ?? {},
      instructions: seed.instructions ?? "",
      archive,
      createdBy: seed.createdBy,
      createdAt: seed.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    };
    this.skills.set(skill.id, skill);
    return skill;
  }

  list(): Promise<Result<SkillSummary[], string>> {
    return notImplemented("list");
  }

  getById(): Promise<Result<Skill | null, string>> {
    return notImplemented("getById");
  }

  getBySkillId(skillId: string): Promise<Result<Skill | null, string>> {
    if (this.getBySkillIdOverride) return Promise.resolve(this.getBySkillIdOverride);
    for (const s of this.skills.values()) {
      if (s.skillId === skillId) return Promise.resolve({ ok: true, data: s });
    }
    return Promise.resolve({ ok: true, data: null });
  }

  publish(
    namespace: string,
    name: string,
    createdBy: string,
    input: PublishSkillInput,
  ): Promise<Result<{ id: string; version: number; name: string; skillId: string }, string>> {
    const skillId = input.skillId ?? `skill-${this.skills.size + 1}`;
    let maxVersion = 0;
    for (const s of this.skills.values()) {
      if (s.skillId === skillId && s.version > maxVersion) maxVersion = s.version;
    }
    const version = maxVersion + 1;

    let archive: Uint8Array<ArrayBuffer> | null = null;
    if (input.archive) {
      const buf = new ArrayBuffer(input.archive.byteLength);
      archive = new Uint8Array(buf);
      archive.set(input.archive);
    }

    const id = `id-${this.skills.size + 1}`;
    const skill: Skill = {
      id,
      skillId,
      namespace,
      name,
      version,
      description: input.description ?? "",
      descriptionManual: input.descriptionManual ?? false,
      disabled: false,
      frontmatter: input.frontmatter ?? {},
      instructions: input.instructions,
      archive,
      createdBy,
      createdAt: new Date(),
    };
    this.skills.set(id, skill);
    return Promise.resolve({ ok: true, data: { id, version, name, skillId } });
  }

  setDisabled(skillId: string, disabled: boolean): Promise<Result<void, string>> {
    for (const s of this.skills.values()) {
      if (s.skillId === skillId) s.disabled = disabled;
    }
    return Promise.resolve({ ok: true, data: undefined });
  }

  // The remainder are unused by the v1 import branch — throw on access.
  create(): Promise<Result<{ skillId: string }, string>> {
    return notImplemented("create");
  }
  get(): Promise<Result<Skill | null, string>> {
    return notImplemented("get");
  }
  listVersions(): Promise<Result<VersionInfo[], string>> {
    return notImplemented("listVersions");
  }
  deleteVersion(): Promise<Result<void, string>> {
    return notImplemented("deleteVersion");
  }
  deleteSkill(): Promise<Result<void, string>> {
    return notImplemented("deleteSkill");
  }
  listAssigned(): Promise<Result<SkillSummary[], string>> {
    return notImplemented("listAssigned");
  }
  assignSkill(): Promise<Result<void, string>> {
    return notImplemented("assignSkill");
  }
  unassignSkill(): Promise<Result<void, string>> {
    return notImplemented("unassignSkill");
  }
  listAssignments(): Promise<Result<string[], string>> {
    return notImplemented("listAssignments");
  }
  assignToJob(): Promise<Result<void, string>> {
    return notImplemented("assignToJob");
  }
  unassignFromJob(): Promise<Result<void, string>> {
    return notImplemented("unassignFromJob");
  }
  listAssignmentsForJob(): Promise<Result<SkillSummary[], string>> {
    return notImplemented("listAssignmentsForJob");
  }
  listJobOnlySkillIds(): Promise<Result<string[], string>> {
    return notImplemented("listJobOnlySkillIds");
  }
}

/**
 * Cast the in-memory shim to the importer's expected type. The v1 branch never
 * touches `replayVersion` — if a v2 archive ever lands at this shim, the
 * missing method throws TypeError loudly. Tripwire, not silent fake.
 */
function asV1Target(shim: InMemorySkillAdapter): SkillStorageAdapter & SkillReplayer {
  return shim as unknown as SkillStorageAdapter & SkillReplayer;
}

async function buildV1Archive(
  rows: SkillRowV1[],
  skillIdToArchiveBytes: Map<string, Uint8Array>,
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [skillId, archiveBytes] of skillIdToArchiveBytes) {
    const row = rows.find((r) => r.skillId === skillId);
    if (!row?.archive) continue;
    zip.file(row.archive.path, archiveBytes);
  }
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
  const jsonlBytes = new TextEncoder().encode(jsonl);
  const sha = await sha256Hex(jsonlBytes);
  const manifest = {
    schemaVersion: 1,
    kind: "global-skills",
    source: { filename: "skills.jsonl", skillCount: rows.length, sha256: `sha256:${sha}` },
  };
  zip.file("manifest.yml", stringifyYaml(manifest));
  zip.file("skills.jsonl", jsonlBytes);
  return await zip.generateAsync({ type: "uint8array" });
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", b.slice());
  return Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function v1Row(overrides: Partial<SkillRowV1> & Pick<SkillRowV1, "skillId" | "name">): SkillRowV1 {
  return {
    skillId: overrides.skillId,
    namespace: overrides.namespace ?? "user",
    name: overrides.name,
    version: overrides.version ?? 1,
    description: overrides.description ?? "",
    descriptionManual: overrides.descriptionManual ?? false,
    disabled: overrides.disabled ?? false,
    frontmatter: overrides.frontmatter ?? {},
    instructions: overrides.instructions ?? "ins",
    createdBy: overrides.createdBy ?? "user-1",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    archive: overrides.archive ?? null,
  };
}

describe("importGlobalSkills — v1 backwards-compat", () => {
  it("imports a v1-shaped archive into an empty target via publish()", async () => {
    const target = new InMemorySkillAdapter();
    const row = v1Row({ skillId: "abc", name: "alpha" });
    const zipBytes = await buildV1Archive([row], new Map());

    const result = await importGlobalSkills({ zipBytes, adapter: asV1Target(target) });
    expect(result.status).toEqual({ kind: "imported", skillsPublished: 1, skillsSkipped: 0 });

    const post = await target.getBySkillId("abc");
    if (!post.ok || !post.data) throw new Error("missing post-import");
    expect(post.data.version).toBe(1);
    expect(post.data.name).toBe("alpha");
  });

  it("v1 presence-skip: any pre-existing skillId is left alone", async () => {
    const target = new InMemorySkillAdapter();
    target.seed({
      skillId: "abc",
      namespace: "user",
      name: "alpha",
      version: 2,
      createdBy: "user-1",
    });
    const row = v1Row({ skillId: "abc", name: "alpha", version: 5 });
    const zipBytes = await buildV1Archive([row], new Map());

    const result = await importGlobalSkills({ zipBytes, adapter: asV1Target(target) });
    expect(result.status).toEqual({ kind: "imported", skillsPublished: 0, skillsSkipped: 1 });

    const post = await target.getBySkillId("abc");
    if (!post.ok || !post.data) throw new Error("missing");
    expect(post.data.version).toBe(2);
  });

  it("v1 fail-loud on getBySkillId failure (review comment 2)", async () => {
    const target = new InMemorySkillAdapter();
    target.getBySkillIdOverride = { ok: false, error: "broker exploded" };
    const row = v1Row({ skillId: "boom-skill", name: "boom" });
    const zipBytes = await buildV1Archive([row], new Map());

    await expect(
      importGlobalSkills({ zipBytes, adapter: asV1Target(target) }),
    ).rejects.toThrowError(/boom-skill.*broker exploded/);
  });

  it("throws LegacyArchiveError when manifest source.filename is skills.db", async () => {
    const target = new InMemorySkillAdapter();
    const legacyManifest = {
      schemaVersion: 1,
      kind: "global-skills",
      source: { filename: "skills.db", sha256: `sha256:${"0".repeat(64)}` },
    };
    const zip = new JSZip();
    zip.file("manifest.yml", stringifyYaml(legacyManifest));
    const zipBytes = await zip.generateAsync({ type: "uint8array" });

    await expect(
      importGlobalSkills({ zipBytes, adapter: asV1Target(target) }),
    ).rejects.toBeInstanceOf(LegacyArchiveError);
  });
});
