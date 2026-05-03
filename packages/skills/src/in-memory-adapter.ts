/**
 * In-memory `SkillStorageAdapter` — tests only.
 *
 * Production daemons run `JetStreamSkillAdapter`. This in-memory variant
 * exists so the global vitest setup can wire `SkillStorage` to a sane
 * default without standing up a NATS test server for every suite that
 * happens to load workspace-runtime code (which transitively loads
 * skill-aware agents). It implements just enough of the contract for
 * read-mostly callers; tests that exercise real skill semantics
 * should construct + register a real `JetStreamSkillAdapter` against a
 * NATS test server.
 */

// deno-lint-ignore-file require-await -- in-memory adapter intentionally
// has no async work; methods stay `async` so they conform to the
// SkillStorageAdapter Promise-returning contract.

import { type Result, success } from "@atlas/utils";
import { customAlphabet } from "nanoid";
import { ulid } from "ulid";
import type { PublishSkillInput, Skill, SkillSort, SkillSummary, VersionInfo } from "./schemas.ts";
import type { SkillStorageAdapter } from "./storage.ts";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 16);

export class InMemorySkillAdapter implements SkillStorageAdapter {
  private skills = new Map<string, Skill[]>(); // skillId → ordered versions
  private nameIndex = new Map<string, string>(); // `${namespace}/${name}` → skillId
  private idIndex = new Map<string, { skillId: string; version: number }>();
  private wsAssignments = new Set<string>(); // `${skillId}/${workspaceId}`
  private jobAssignments = new Set<string>(); // `${skillId}/${workspaceId}/${jobName}`

  async create(namespace: string, createdBy: string): Promise<Result<{ skillId: string }, string>> {
    const skillId = nanoid();
    const id = ulid();
    const skill: Skill = {
      id,
      skillId,
      namespace,
      name: null,
      version: 1,
      description: "",
      descriptionManual: false,
      disabled: false,
      frontmatter: {},
      instructions: "",
      archive: null,
      createdBy,
      createdAt: new Date(),
    };
    this.skills.set(skillId, [skill]);
    this.idIndex.set(id, { skillId, version: 1 });
    return success({ skillId });
  }

  async publish(
    namespace: string,
    name: string,
    createdBy: string,
    input: PublishSkillInput,
  ): Promise<Result<{ id: string; version: number; name: string; skillId: string }, string>> {
    const id = ulid();
    let skillId = input.skillId;
    if (!skillId) {
      skillId = this.nameIndex.get(`${namespace}/${name}`) ?? nanoid();
    }
    const versions = this.skills.get(skillId) ?? [];
    const version = (versions[versions.length - 1]?.version ?? 0) + 1;
    if (input.skillId && versions.length > 0 && versions[0]?.name !== name) {
      const oldName = versions[0]?.name;
      for (const v of versions) v.name = name;
      if (oldName) this.nameIndex.delete(`${namespace}/${oldName}`);
    }
    const archive = input.archive ?? versions[versions.length - 1]?.archive ?? null;
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
      archive: archive as Skill["archive"],
      createdBy,
      createdAt: new Date(),
    };
    versions.push(skill);
    this.skills.set(skillId, versions);
    this.nameIndex.set(`${namespace}/${name}`, skillId);
    this.idIndex.set(id, { skillId, version });
    return success({ id, version, name, skillId });
  }

  async get(
    namespace: string,
    name: string,
    version?: number,
  ): Promise<Result<Skill | null, string>> {
    const skillId = this.nameIndex.get(`${namespace}/${name}`);
    if (!skillId) return success(null);
    const versions = this.skills.get(skillId) ?? [];
    if (version !== undefined) {
      return success(versions.find((v) => v.version === version) ?? null);
    }
    return success(versions[versions.length - 1] ?? null);
  }

  async getById(id: string): Promise<Result<Skill | null, string>> {
    const loc = this.idIndex.get(id);
    if (!loc) return success(null);
    const versions = this.skills.get(loc.skillId) ?? [];
    return success(versions.find((v) => v.version === loc.version) ?? null);
  }

  async getBySkillId(skillId: string): Promise<Result<Skill | null, string>> {
    const versions = this.skills.get(skillId) ?? [];
    return success(versions[versions.length - 1] ?? null);
  }

  async list(
    namespace?: string,
    query?: string,
    includeAll?: boolean,
    _sort: SkillSort = "name",
  ): Promise<Result<SkillSummary[], string>> {
    const out: SkillSummary[] = [];
    for (const versions of this.skills.values()) {
      const latest = versions[versions.length - 1];
      if (!latest) continue;
      if (!includeAll) {
        if (latest.name === null) continue;
        if (latest.description === "") continue;
        if (latest.disabled) continue;
      }
      if (namespace && latest.namespace !== namespace) continue;
      if (query) {
        const q = query.toLowerCase();
        const ok =
          (latest.name?.toLowerCase().includes(q) ?? false) ||
          latest.description.toLowerCase().includes(q);
        if (!ok) continue;
      }
      out.push({
        id: latest.id,
        skillId: latest.skillId,
        namespace: latest.namespace,
        name: latest.name,
        description: latest.description,
        disabled: latest.disabled,
        latestVersion: latest.version,
        createdAt: latest.createdAt,
        source:
          typeof latest.frontmatter.source === "string" ? latest.frontmatter.source : undefined,
      });
    }
    return success(out);
  }

  async listVersions(namespace: string, name: string): Promise<Result<VersionInfo[], string>> {
    const skillId = this.nameIndex.get(`${namespace}/${name}`);
    if (!skillId) return success([]);
    const versions = this.skills.get(skillId) ?? [];
    return success(
      versions
        .map((v) => ({ version: v.version, createdAt: v.createdAt, createdBy: v.createdBy }))
        .sort((a, b) => b.version - a.version),
    );
  }

  async deleteVersion(
    namespace: string,
    name: string,
    version: number,
  ): Promise<Result<void, string>> {
    const skillId = this.nameIndex.get(`${namespace}/${name}`);
    if (!skillId) return success(undefined);
    const versions = this.skills.get(skillId) ?? [];
    this.skills.set(
      skillId,
      versions.filter((v) => v.version !== version),
    );
    return success(undefined);
  }

  async setDisabled(skillId: string, disabled: boolean): Promise<Result<void, string>> {
    const versions = this.skills.get(skillId) ?? [];
    for (const v of versions) v.disabled = disabled;
    return success(undefined);
  }

  async deleteSkill(skillId: string): Promise<Result<void, string>> {
    const versions = this.skills.get(skillId) ?? [];
    const latest = versions[versions.length - 1];
    this.skills.delete(skillId);
    if (latest?.name) this.nameIndex.delete(`${latest.namespace}/${latest.name}`);
    for (const v of versions) this.idIndex.delete(v.id);
    for (const k of [...this.wsAssignments])
      if (k.startsWith(`${skillId}/`)) this.wsAssignments.delete(k);
    for (const k of [...this.jobAssignments])
      if (k.startsWith(`${skillId}/`)) this.jobAssignments.delete(k);
    return success(undefined);
  }

  async listAssigned(workspaceId: string): Promise<Result<SkillSummary[], string>> {
    const skillIds = [...this.wsAssignments]
      .filter((k) => k.endsWith(`/${workspaceId}`))
      .map((k) => k.split("/")[0]!);
    return this.summariesForSkillIds(skillIds);
  }

  async assignSkill(skillId: string, workspaceId: string): Promise<Result<void, string>> {
    this.wsAssignments.add(`${skillId}/${workspaceId}`);
    return success(undefined);
  }

  async unassignSkill(skillId: string, workspaceId: string): Promise<Result<void, string>> {
    this.wsAssignments.delete(`${skillId}/${workspaceId}`);
    return success(undefined);
  }

  async listAssignments(skillId: string): Promise<Result<string[], string>> {
    const seen = new Set<string>();
    for (const k of this.wsAssignments) {
      const [s, ws] = k.split("/");
      if (s === skillId && ws) seen.add(ws);
    }
    for (const k of this.jobAssignments) {
      const [s, ws] = k.split("/");
      if (s === skillId && ws) seen.add(ws);
    }
    return success([...seen]);
  }

  async assignToJob(
    skillId: string,
    workspaceId: string,
    jobName: string,
  ): Promise<Result<void, string>> {
    this.jobAssignments.add(`${skillId}/${workspaceId}/${jobName}`);
    return success(undefined);
  }

  async unassignFromJob(
    skillId: string,
    workspaceId: string,
    jobName: string,
  ): Promise<Result<void, string>> {
    this.jobAssignments.delete(`${skillId}/${workspaceId}/${jobName}`);
    return success(undefined);
  }

  async listAssignmentsForJob(
    workspaceId: string,
    jobName: string,
  ): Promise<Result<SkillSummary[], string>> {
    const skillIds = [...this.jobAssignments]
      .filter((k) => k.endsWith(`/${workspaceId}/${jobName}`))
      .map((k) => k.split("/")[0]!);
    return this.summariesForSkillIds(skillIds);
  }

  async listJobOnlySkillIds(): Promise<Result<string[], string>> {
    const ws = new Set<string>();
    const job = new Set<string>();
    for (const k of this.wsAssignments) ws.add(k.split("/")[0]!);
    for (const k of this.jobAssignments) job.add(k.split("/")[0]!);
    return success([...job].filter((id) => !ws.has(id)));
  }

  private summariesForSkillIds(ids: string[]): Result<SkillSummary[], string> {
    const out: SkillSummary[] = [];
    for (const skillId of ids) {
      const versions = this.skills.get(skillId) ?? [];
      const latest = versions[versions.length - 1];
      if (!latest) continue;
      if (latest.name === null || latest.description === "" || latest.disabled) continue;
      out.push({
        id: latest.id,
        skillId: latest.skillId,
        namespace: latest.namespace,
        name: latest.name,
        description: latest.description,
        disabled: latest.disabled,
        latestVersion: latest.version,
        createdAt: latest.createdAt,
        source:
          typeof latest.frontmatter.source === "string" ? latest.frontmatter.source : undefined,
      });
    }
    return success(out);
  }
}
