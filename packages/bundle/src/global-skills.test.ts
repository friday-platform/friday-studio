/**
 * Bundle v2 export/import tests — all driven against the real
 * `JetStreamSkillAdapter` via the shared NATS test server in
 * `vitest.setup.ts`. v1 backwards-compat is exercised by hand-building a
 * v1-shaped JSONL archive (legacy `schemaVersion: 1`, `skills.jsonl`, row
 * schema without `id` / `createdAt` / discriminated archive) and importing
 * into a real adapter — same fixture-build pattern used in
 * `m_20260503_110100_skills_to_jetstream.test.ts`.
 */

import { JetStreamSkillAdapter, type Skill, type SkillStorageAdapter } from "@atlas/skills";
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
  SkillRowV2Schema,
} from "./global-skills.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Shared NATS harness
// ──────────────────────────────────────────────────────────────────────────────

let nc: NatsConnection;

beforeAll(() => {
  nc = getTestNc();
});

afterEach(async () => {
  // SKILLS KV + SKILL_ARCHIVES Object Store are global — wipe between tests so
  // replayVersion's duplicate-rejection guard doesn't trip across cases.
  await wipeBuckets();
});

async function wipeBuckets(): Promise<void> {
  const facade = createJetStreamFacade(nc);
  await facade.kv.delete("SKILLS");
  await facade.os.delete("SKILL_ARCHIVES");
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

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

async function sha256Hex(b: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", b.slice());
  return Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

// ──────────────────────────────────────────────────────────────────────────────
// v2 export
// ──────────────────────────────────────────────────────────────────────────────

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
      .map((l) => SkillRowV2Schema.parse(JSON.parse(l)));
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
      .map((l) => SkillRowV2Schema.parse(JSON.parse(l)));
    expect(rows[0]?.archive.kind).toBe("bytes");
    expect(rows[1]?.archive.kind).toBe("inherited");
    expect(rows[2]?.archive.kind).toBe("bytes");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// v2 round-trip
// ──────────────────────────────────────────────────────────────────────────────

describe("importGlobalSkills (v2 round-trip)", () => {
  it("empty target + multi-version source: imports all 3, idempotent on re-import", async () => {
    const source = new JetStreamSkillAdapter(nc);
    const seeded = await seedVersion(source, { namespace: "user", name: "skill-a" });
    await seedVersion(source, { namespace: "user", name: "skill-a", skillId: seeded.skillId });
    await seedVersion(source, { namespace: "user", name: "skill-a", skillId: seeded.skillId });

    const exported = await exportGlobalSkills({ adapter: source });
    if (!exported.bytes) throw new Error("expected bytes");
    const zipBytes = exported.bytes;

    await wipeBuckets();

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

    await wipeBuckets();

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

    await wipeBuckets();

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

    await wipeBuckets();

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

    await wipeBuckets();

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

    await wipeBuckets();

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

    await wipeBuckets();

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

    await wipeBuckets();

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

    await wipeBuckets();

    const target = new JetStreamSkillAdapter(nc);
    const result = await importGlobalSkills({ zipBytes: tamperedZipBytes, adapter: target });
    expect(result.status.kind).toBe("integrity-failed");
    if (result.status.kind !== "integrity-failed") throw new Error("unreachable");
    expect(result.status.row).toContain(seeded.skillId);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// v1 backwards-compat — hand-built v1-shaped archive against real adapter
// ──────────────────────────────────────────────────────────────────────────────

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

async function buildV1Archive(rows: SkillRowV1[]): Promise<Uint8Array> {
  const zip = new JSZip();
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

describe("importGlobalSkills — v1 backwards-compat", () => {
  it("imports a v1-shaped archive into an empty target via publish", async () => {
    const target = new JetStreamSkillAdapter(nc);
    const zipBytes = await buildV1Archive([
      v1Row({ skillId: "v1-abc", name: "alpha", instructions: "v1 ins" }),
    ]);

    const result = await importGlobalSkills({ zipBytes, adapter: target });
    expect(result.status).toEqual({ kind: "imported", skillsPublished: 1, skillsSkipped: 0 });

    const post = await target.getBySkillId("v1-abc");
    if (!post.ok || !post.data) throw new Error("missing post-import");
    // publish() lands at version 1 because the target is empty.
    expect(post.data.version).toBe(1);
    expect(post.data.name).toBe("alpha");
  });

  it("v1 presence-skip: any pre-existing skillId is left alone on re-import", async () => {
    const target = new JetStreamSkillAdapter(nc);
    const zipBytes = await buildV1Archive([
      v1Row({ skillId: "v1-pre", name: "alpha", instructions: "v1 ins" }),
    ]);

    const first = await importGlobalSkills({ zipBytes, adapter: target });
    expect(first.status).toEqual({ kind: "imported", skillsPublished: 1, skillsSkipped: 0 });

    const second = await importGlobalSkills({ zipBytes, adapter: target });
    expect(second.status).toEqual({ kind: "imported", skillsPublished: 0, skillsSkipped: 1 });

    // Version did not inflate.
    const post = await target.getBySkillId("v1-pre");
    if (!post.ok || !post.data) throw new Error("missing");
    expect(post.data.version).toBe(1);
  });

  it("v1 round-trips a disabled flag via setDisabled", async () => {
    const target = new JetStreamSkillAdapter(nc);
    const zipBytes = await buildV1Archive([
      v1Row({ skillId: "v1-disabled", name: "disabled-skill", disabled: true }),
    ]);

    const result = await importGlobalSkills({ zipBytes, adapter: target });
    expect(result.status.kind).toBe("imported");

    const post = await target.getBySkillId("v1-disabled");
    if (!post.ok || !post.data) throw new Error("missing");
    expect(post.data.disabled).toBe(true);
  });

  it("v1 fail-loud on getBySkillId failure (review comment 2)", async () => {
    // Wrap a real adapter; force the v1 branch's one `getBySkillId` call to
    // surface a Result.fail, asserting the importer throws with the skillId
    // and underlying error in the message instead of falling through.
    class FailingGetBySkillId extends JetStreamSkillAdapter {
      override getBySkillId(_skillId: string): Promise<Result<Skill | null, string>> {
        return Promise.resolve({ ok: false, error: "broker exploded" });
      }
    }
    const target = new FailingGetBySkillId(nc);
    const zipBytes = await buildV1Archive([
      v1Row({ skillId: "boom-skill", name: "boom", instructions: "i" }),
    ]);

    await expect(importGlobalSkills({ zipBytes, adapter: target })).rejects.toThrowError(
      /boom-skill.*broker exploded/,
    );
  });

  it("throws LegacyArchiveError when manifest source.filename is skills.db", async () => {
    const target = new JetStreamSkillAdapter(nc);
    const legacyManifest = {
      schemaVersion: 1,
      kind: "global-skills",
      source: { filename: "skills.db", sha256: `sha256:${"0".repeat(64)}` },
    };
    const zip = new JSZip();
    zip.file("manifest.yml", stringifyYaml(legacyManifest));
    const zipBytes = await zip.generateAsync({ type: "uint8array" });

    await expect(importGlobalSkills({ zipBytes, adapter: target })).rejects.toBeInstanceOf(
      LegacyArchiveError,
    );
  });
});
