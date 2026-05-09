import type {
  PublishSkillInput,
  Skill,
  SkillStorageAdapter,
  SkillSummary,
  VersionInfo,
} from "@atlas/skills";
import type { SkillSort } from "@atlas/skills/schemas";
import type { Result } from "@atlas/utils";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  exportGlobalSkills,
  type GlobalSkillsManifest,
  GlobalSkillsManifestSchema,
  importGlobalSkills,
  LegacyArchiveError,
  SkillRowSchema,
} from "./global-skills.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Test shim
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

  seed(seed: SeedSkill): Skill {
    // Repack the archive bytes into an ArrayBuffer-backed Uint8Array; the
    // Skill schema's archive field is `Uint8Array<ArrayBuffer>`, but
    // TextEncoder produces `Uint8Array<ArrayBufferLike>`.
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

  list(
    _namespace?: string,
    _query?: string,
    _includeAll?: boolean,
    _sort?: SkillSort,
  ): Promise<Result<SkillSummary[], string>> {
    const summaries: SkillSummary[] = Array.from(this.skills.values()).map((s) => ({
      id: s.id,
      skillId: s.skillId,
      namespace: s.namespace,
      name: s.name,
      description: s.description,
      disabled: s.disabled,
      latestVersion: s.version,
      createdAt: s.createdAt,
      userInvocable: true,
    }));
    return Promise.resolve({ ok: true, data: summaries });
  }

  getById(id: string): Promise<Result<Skill | null, string>> {
    return Promise.resolve({ ok: true, data: this.skills.get(id) ?? null });
  }

  getBySkillId(skillId: string): Promise<Result<Skill | null, string>> {
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

  // Unused — throw to surface accidental coupling.
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

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function loadExportedZip(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const manifestEntry = zip.file("manifest.yml");
  const jsonlEntry = zip.file("skills.jsonl");
  if (!manifestEntry || !jsonlEntry) throw new Error("missing manifest or jsonl");
  const manifestYaml = await manifestEntry.async("string");
  const jsonlBytes = await jsonlEntry.async("uint8array");
  const manifest = GlobalSkillsManifestSchema.parse(parseYaml(manifestYaml));
  const jsonlText = new TextDecoder().decode(jsonlBytes);
  const rows = jsonlText
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => SkillRowSchema.parse(JSON.parse(line)));
  return { zip, manifest, rows, jsonlBytes };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("exportGlobalSkills", () => {
  it("emits a zip with manifest + JSONL + per-archive entries", async () => {
    const adapter = new InMemorySkillAdapter();
    const archiveBytes = new TextEncoder().encode("pretend-tar-gz-bytes");
    adapter.seed({
      skillId: "skill-a",
      namespace: "user",
      name: "alpha",
      version: 3,
      description: "alpha skill",
      instructions: "do alpha",
      archive: archiveBytes,
      createdBy: "user-1",
    });
    adapter.seed({
      skillId: "skill-b",
      namespace: "user",
      name: "beta",
      disabled: true,
      instructions: "do beta",
      archive: new TextEncoder().encode("beta-archive"),
      createdBy: "user-1",
    });
    adapter.seed({
      skillId: "skill-c",
      namespace: "user",
      name: "gamma",
      instructions: "do gamma",
      archive: null,
      createdBy: "user-1",
    });

    const result = await exportGlobalSkills({ adapter });
    if (!result.bytes) throw new Error("expected bytes");
    expect(result.manifest?.source.skillCount).toBe(3);

    const { manifest, rows, jsonlBytes, zip } = await loadExportedZip(result.bytes);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.source.filename).toBe("skills.jsonl");
    expect(manifest.source.skillCount).toBe(3);
    expect(manifest.source.sha256).toBe(`sha256:${await sha256Hex(jsonlBytes)}`);

    expect(rows).toHaveLength(3);
    const byName = new Map(rows.map((r) => [r.name, r]));

    const alpha = byName.get("alpha");
    if (!alpha) throw new Error("missing alpha row");
    expect(alpha.skillId).toBe("skill-a");
    expect(alpha.namespace).toBe("user");
    expect(alpha.version).toBe(3);
    expect(alpha.disabled).toBe(false);
    if (!alpha.archive) throw new Error("expected alpha to carry archive metadata");
    expect(alpha.archive.path).toBe("archives/skill-a__3.tar.gz");
    expect(alpha.archive.byteSize).toBe(archiveBytes.byteLength);
    expect(alpha.archive.sha256).toBe(`sha256:${await sha256Hex(archiveBytes)}`);
    const alphaArchive = zip.file(alpha.archive.path);
    if (!alphaArchive) throw new Error("expected alpha archive entry in zip");
    const alphaArchiveBytes = await alphaArchive.async("uint8array");
    expect(alphaArchiveBytes).toEqual(archiveBytes);

    const beta = byName.get("beta");
    if (!beta) throw new Error("missing beta row");
    expect(beta.disabled).toBe(true);
    if (!beta.archive) throw new Error("expected beta to carry archive metadata");
    expect(zip.file(beta.archive.path)).not.toBeNull();

    const gamma = byName.get("gamma");
    if (!gamma) throw new Error("missing gamma row");
    expect(gamma.archive).toBeNull();
  });

  it("filters out skills with createdBy === SYSTEM_USER_ID", async () => {
    const adapter = new InMemorySkillAdapter();
    adapter.seed({
      skillId: "user-1",
      namespace: "user",
      name: "one",
      instructions: "i1",
      createdBy: "user-x",
    });
    adapter.seed({
      skillId: "user-2",
      namespace: "user",
      name: "two",
      instructions: "i2",
      createdBy: "user-x",
    });
    adapter.seed({
      skillId: "sys-1",
      namespace: "friday",
      name: "system-skill",
      instructions: "sys",
      createdBy: "system",
    });

    const result = await exportGlobalSkills({ adapter });
    if (!result.bytes) throw new Error("expected bytes");
    const { manifest, rows } = await loadExportedZip(result.bytes);

    expect(manifest.source.skillCount).toBe(2);
    expect(rows).toHaveLength(2);
    const skillIds = rows.map((r) => r.skillId);
    expect(skillIds).toContain("user-1");
    expect(skillIds).toContain("user-2");
    expect(skillIds).not.toContain("sys-1");
  });

  it("returns { bytes: null } when the adapter has no exportable skills", async () => {
    const empty = await exportGlobalSkills({ adapter: new InMemorySkillAdapter() });
    expect(empty.bytes).toBeNull();
    expect(empty.manifest).toBeUndefined();

    const onlySystem = new InMemorySkillAdapter();
    onlySystem.seed({
      skillId: "sys-1",
      namespace: "friday",
      name: "system-skill",
      instructions: "sys",
      createdBy: "system",
    });
    const filtered = await exportGlobalSkills({ adapter: onlySystem });
    expect(filtered.bytes).toBeNull();
    expect(filtered.manifest).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Import tests
// ──────────────────────────────────────────────────────────────────────────────

async function buildArchive(
  adapter: InMemorySkillAdapter,
): Promise<{ zipBytes: Uint8Array; manifest: GlobalSkillsManifest }> {
  const result = await exportGlobalSkills({ adapter });
  if (!result.bytes || !result.manifest) {
    throw new Error("buildArchive: expected non-empty export");
  }
  return { zipBytes: result.bytes, manifest: result.manifest };
}

describe("importGlobalSkills", () => {
  it("skips rows already present at >= version (idempotent re-import)", async () => {
    const source = new InMemorySkillAdapter();
    source.seed({
      skillId: "abc",
      namespace: "user",
      name: "alpha",
      version: 2,
      instructions: "do alpha",
      createdBy: "user-1",
    });
    const { zipBytes } = await buildArchive(source);

    const target = new InMemorySkillAdapter();
    target.seed({
      skillId: "abc",
      namespace: "user",
      name: "alpha",
      version: 2,
      instructions: "do alpha",
      createdBy: "user-1",
    });

    const result = await importGlobalSkills({ zipBytes, adapter: target });
    expect(result.status).toEqual({ kind: "imported", skillsPublished: 0, skillsSkipped: 1 });

    const post = await target.getBySkillId("abc");
    if (!post.ok || !post.data) throw new Error("abc missing post-import");
    expect(post.data.version).toBe(2);
  });

  it("returns integrity-failed when manifest sha doesn't match jsonl bytes", async () => {
    const source = new InMemorySkillAdapter();
    source.seed({
      skillId: "abc",
      namespace: "user",
      name: "alpha",
      instructions: "do alpha",
      createdBy: "user-1",
    });
    const { zipBytes } = await buildArchive(source);

    // Tamper: append a newline to skills.jsonl, leave manifest untouched.
    const zip = await JSZip.loadAsync(zipBytes);
    const original = await zip.file("skills.jsonl")!.async("uint8array");
    const tampered = new Uint8Array(original.byteLength + 1);
    tampered.set(original);
    tampered[original.byteLength] = 0x0a; // "\n"
    zip.file("skills.jsonl", tampered);
    const tamperedZipBytes = await zip.generateAsync({ type: "uint8array" });

    const target = new InMemorySkillAdapter();
    const result = await importGlobalSkills({ zipBytes: tamperedZipBytes, adapter: target });
    expect(result.status.kind).toBe("integrity-failed");
    if (result.status.kind !== "integrity-failed") throw new Error("unreachable");
    expect(result.status.expected).not.toBe(result.status.actual);
    expect(result.status.row).toBeUndefined();
  });

  it("returns integrity-failed with row id when archive sha doesn't match", async () => {
    const source = new InMemorySkillAdapter();
    source.seed({
      skillId: "abc",
      namespace: "user",
      name: "alpha",
      instructions: "do alpha",
      archive: new TextEncoder().encode("good archive bytes"),
      createdBy: "user-1",
    });
    const { zipBytes } = await buildArchive(source);

    // Tamper one archive entry; leave skills.jsonl untouched so the outer
    // sha still matches and the per-archive sha is what fails.
    const zip = await JSZip.loadAsync(zipBytes);
    const archivePath = "archives/abc__1.tar.gz";
    expect(zip.file(archivePath)).not.toBeNull();
    zip.file(archivePath, new TextEncoder().encode("garbage"));
    const tamperedZipBytes = await zip.generateAsync({ type: "uint8array" });

    const target = new InMemorySkillAdapter();
    const result = await importGlobalSkills({ zipBytes: tamperedZipBytes, adapter: target });
    expect(result.status.kind).toBe("integrity-failed");
    if (result.status.kind !== "integrity-failed") throw new Error("unreachable");
    expect(result.status.row).toBe("abc");
    expect(result.status.expected).not.toBe(result.status.actual);
  });

  it("publishes rows into a fresh adapter and round-trips archive + disabled state", async () => {
    const source = new InMemorySkillAdapter();
    const alphaArchive = new TextEncoder().encode("alpha-archive-bytes");
    source.seed({
      skillId: "alpha",
      namespace: "user",
      name: "alpha",
      instructions: "do alpha",
      archive: alphaArchive,
      createdBy: "user-1",
    });
    source.seed({
      skillId: "beta",
      namespace: "user",
      name: "beta",
      instructions: "do beta",
      disabled: true,
      createdBy: "user-1",
    });
    source.seed({
      skillId: "gamma",
      namespace: "user",
      name: "gamma",
      instructions: "do gamma",
      archive: null,
      createdBy: "user-1",
    });
    const { zipBytes } = await buildArchive(source);

    const target = new InMemorySkillAdapter();
    const result = await importGlobalSkills({ zipBytes, adapter: target });

    expect(result.status).toEqual({ kind: "imported", skillsPublished: 3, skillsSkipped: 0 });

    const alpha = await target.getBySkillId("alpha");
    if (!alpha.ok || !alpha.data) throw new Error("alpha missing post-import");
    expect(alpha.data.namespace).toBe("user");
    expect(alpha.data.name).toBe("alpha");
    expect(alpha.data.disabled).toBe(false);
    if (!alpha.data.archive) throw new Error("alpha archive missing post-import");
    expect(alpha.data.archive).toEqual(alphaArchive);

    const beta = await target.getBySkillId("beta");
    if (!beta.ok || !beta.data) throw new Error("beta missing post-import");
    expect(beta.data.disabled).toBe(true);
    expect(beta.data.archive).toBeNull();

    const gamma = await target.getBySkillId("gamma");
    if (!gamma.ok || !gamma.data) throw new Error("gamma missing post-import");
    expect(gamma.data.disabled).toBe(false);
    expect(gamma.data.archive).toBeNull();
  });

  it("throws LegacyArchiveError when manifest source.filename is skills.db", async () => {
    const legacyManifest = {
      schemaVersion: 1,
      kind: "global-skills",
      source: { filename: "skills.db", sha256: `sha256:${"0".repeat(64)}` },
    };
    const zip = new JSZip();
    zip.file("manifest.yml", stringifyYaml(legacyManifest));
    const zipBytes = await zip.generateAsync({ type: "uint8array" });

    const target = new InMemorySkillAdapter();
    await expect(importGlobalSkills({ zipBytes, adapter: target })).rejects.toBeInstanceOf(
      LegacyArchiveError,
    );
  });
});
