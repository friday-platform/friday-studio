/**
 * JetStream-backed `SkillStorageAdapter`.
 *
 * Replaces the SQLite `LocalSkillAdapter`. Bundled skills (the
 * `packages/system/skills/<name>/` autoloads stamped with
 * `created_by = "system"`) and `atlas skill publish`-uploaded user
 * skills both flow through this single adapter.
 *
 * **Layout** — single KV bucket `SKILLS` plus an Object Store
 * `OBJ_SKILL_ARCHIVES` for tar.gz blobs that exceed the KV value
 * ceiling (and would inflate the bucket footprint regardless).
 *
 * Hierarchical keys (mapped to flat JS-KV keys via `JetStreamKVStorage`):
 *
 *   ["skill", <skillId>, <version>]              → SkillRecord (no archive bytes)
 *   ["index", "by_id", <id>]                     → { skillId, version }
 *   ["index", "by_name", <namespace>, <name>]    → <skillId>
 *   ["assign_ws", <workspaceId>, <skillId>]      → "" (presence flag)
 *   ["assign_job", <workspaceId>, <jobName>, <skillId>] → "" (presence flag)
 *
 * Object Store keys: `<skillId>/<version>` — fetched lazily on
 * `get*` so list operations stay cheap.
 *
 * **Latest-version semantics** mirror the SQLite GROUP-BY-MAX(version)
 * behavior: list operations scan `["skill", <skillId>]` prefixes, then
 * keep the highest version per skillId in memory. For typical skill
 * counts (single-digit hundreds) this is fine; revisit if a workspace
 * publishes many thousands of skill versions.
 */

import { createJetStreamKVStorage, type KVStorage } from "@atlas/storage";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { customAlphabet } from "nanoid";
import type { NatsConnection, ObjectStore } from "nats";
import { ulid } from "ulid";
import type { PublishSkillInput, Skill, SkillSort, SkillSummary, VersionInfo } from "./schemas.ts";
import type { SkillStorageAdapter } from "./storage.ts";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 16);

const KV_BUCKET = "SKILLS";
const OS_BUCKET = "SKILL_ARCHIVES";

/** Stored skill row — same shape as Skill but without the archive bytes. */
interface SkillRecord {
  id: string;
  skillId: string;
  namespace: string;
  name: string | null;
  version: number;
  description: string;
  descriptionManual: boolean;
  disabled: boolean;
  frontmatter: Record<string, unknown>;
  instructions: string;
  /** Archive lives in OS_SKILL_ARCHIVES under `<skillId>/<version>`. */
  hasArchive: boolean;
  createdBy: string;
  createdAt: string;
}

interface IdLocator {
  skillId: string;
  version: number;
}

export class JetStreamSkillAdapter implements SkillStorageAdapter {
  private kv: KVStorage | null = null;
  private os: ObjectStore | null = null;

  constructor(private readonly nc: NatsConnection) {}

  private async getKV(): Promise<KVStorage> {
    if (!this.kv) {
      this.kv = await createJetStreamKVStorage(this.nc, { bucket: KV_BUCKET, history: 1 });
    }
    return this.kv;
  }

  private async getOS(): Promise<ObjectStore> {
    if (!this.os) {
      this.os = await this.nc.jetstream().views.os(OS_BUCKET);
    }
    return this.os;
  }

  private archiveKey(skillId: string, version: number): string {
    return `${skillId}/${version}`;
  }

  private async putArchive(skillId: string, version: number, bytes: Uint8Array): Promise<void> {
    const os = await this.getOS();
    await os.put({ name: this.archiveKey(skillId, version) }, readableFrom(bytes));
  }

  private async getArchive(skillId: string, version: number): Promise<Uint8Array | null> {
    try {
      const os = await this.getOS();
      const result = await os.get(this.archiveKey(skillId, version));
      if (!result) return null;
      const reader = result.data.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
      }
      return out;
    } catch {
      return null;
    }
  }

  private async getCopiedArchive(
    skillId: string,
    fromVersion: number,
    toVersion: number,
  ): Promise<boolean> {
    const bytes = await this.getArchive(skillId, fromVersion);
    if (!bytes) return false;
    await this.putArchive(skillId, toVersion, bytes);
    return true;
  }

  private toSkill(record: SkillRecord, archive: Uint8Array | null): Skill {
    // The Skill schema's `archive` field is `Uint8Array<ArrayBuffer>`;
    // Object Store streams give us `Uint8Array<ArrayBufferLike>`. Copy
    // into an ArrayBuffer-backed buffer to satisfy the type.
    let typedArchive: Uint8Array<ArrayBuffer> | null = null;
    if (archive) {
      const buf = new ArrayBuffer(archive.byteLength);
      typedArchive = new Uint8Array(buf);
      typedArchive.set(archive);
    }
    return {
      id: record.id,
      skillId: record.skillId,
      namespace: record.namespace,
      name: record.name,
      version: record.version,
      description: record.description,
      descriptionManual: record.descriptionManual,
      disabled: record.disabled,
      frontmatter: record.frontmatter,
      instructions: record.instructions,
      archive: typedArchive,
      createdBy: record.createdBy,
      createdAt: new Date(record.createdAt),
    };
  }

  // ─── Helpers (latest-version selection) ───────────────────────────────

  private async getLatestRecord(skillId: string): Promise<SkillRecord | null> {
    const kv = await this.getKV();
    let best: SkillRecord | null = null;
    for await (const e of kv.list<SkillRecord>(["skill", skillId])) {
      if (!best || e.value.version > best.version) best = e.value;
    }
    return best;
  }

  // ─── CREATE / PUBLISH ─────────────────────────────────────────────────

  async create(namespace: string, createdBy: string): Promise<Result<{ skillId: string }, string>> {
    const kv = await this.getKV();
    const id = ulid();
    const skillId = nanoid();
    const now = new Date().toISOString();

    const record: SkillRecord = {
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
      hasArchive: false,
      createdBy,
      createdAt: now,
    };

    try {
      await kv.set(["skill", skillId, String(1)], record);
      await kv.set<IdLocator>(["index", "by_id", id], { skillId, version: 1 });
      return success({ skillId });
    } catch (e) {
      return fail(stringifyError(e));
    }
  }

  async publish(
    namespace: string,
    name: string,
    createdBy: string,
    input: PublishSkillInput,
  ): Promise<Result<{ id: string; version: number; name: string; skillId: string }, string>> {
    const kv = await this.getKV();
    const id = ulid();
    const now = new Date().toISOString();

    // Resolve skillId: explicit > existing-by-name > new
    let skillId = input.skillId;
    if (!skillId) {
      const existing = await kv.get<string>(["index", "by_name", namespace, name]);
      skillId = existing ?? nanoid();
    }

    // Next version = max(current) + 1
    const latest = await this.getLatestRecord(skillId);
    const version = (latest?.version ?? 0) + 1;

    // Preserve archive from previous version when not provided
    let hasArchive = false;
    if (input.archive) {
      await this.putArchive(skillId, version, input.archive);
      hasArchive = true;
    } else if (latest?.hasArchive) {
      hasArchive = await this.getCopiedArchive(skillId, latest.version, version);
    }

    const record: SkillRecord = {
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
      hasArchive,
      createdBy,
      createdAt: now,
    };

    try {
      // If the caller passed an explicit skillId AND we already have rows
      // under it, propagate the new name to every prior version (matches
      // SQLite UPDATE skills SET name=? WHERE skill_id=?).
      if (input.skillId && latest && latest.name !== name) {
        for await (const e of kv.list<SkillRecord>(["skill", skillId])) {
          if (e.value.name !== name) {
            await kv.set(["skill", skillId, String(e.value.version)], { ...e.value, name });
          }
        }
      }

      await kv.set(["skill", skillId, String(version)], record);
      await kv.set<IdLocator>(["index", "by_id", id], { skillId, version });
      await kv.set<string>(["index", "by_name", namespace, name], skillId);

      return success({ id, version, name, skillId });
    } catch (e) {
      return fail(stringifyError(e));
    }
  }

  // ─── READ ─────────────────────────────────────────────────────────────

  async get(
    namespace: string,
    name: string,
    version?: number,
  ): Promise<Result<Skill | null, string>> {
    const kv = await this.getKV();
    const skillId = await kv.get<string>(["index", "by_name", namespace, name]);
    if (!skillId) return success(null);

    let record: SkillRecord | null;
    if (version !== undefined) {
      record = await kv.get<SkillRecord>(["skill", skillId, String(version)]);
    } else {
      record = await this.getLatestRecord(skillId);
    }
    if (!record) return success(null);

    const archive = record.hasArchive ? await this.getArchive(skillId, record.version) : null;
    return success(this.toSkill(record, archive));
  }

  async getById(id: string): Promise<Result<Skill | null, string>> {
    const kv = await this.getKV();
    const loc = await kv.get<IdLocator>(["index", "by_id", id]);
    if (!loc) return success(null);
    const record = await kv.get<SkillRecord>(["skill", loc.skillId, String(loc.version)]);
    if (!record) return success(null);
    const archive = record.hasArchive ? await this.getArchive(loc.skillId, loc.version) : null;
    return success(this.toSkill(record, archive));
  }

  async getBySkillId(skillId: string): Promise<Result<Skill | null, string>> {
    const record = await this.getLatestRecord(skillId);
    if (!record) return success(null);
    const archive = record.hasArchive ? await this.getArchive(skillId, record.version) : null;
    return success(this.toSkill(record, archive));
  }

  async list(
    namespace?: string,
    query?: string,
    includeAll?: boolean,
    sort: SkillSort = "name",
  ): Promise<Result<SkillSummary[], string>> {
    const kv = await this.getKV();
    const latestBySkillId = new Map<string, SkillRecord>();
    for await (const e of kv.list<SkillRecord>(["skill"])) {
      const cur = latestBySkillId.get(e.value.skillId);
      if (!cur || e.value.version > cur.version) latestBySkillId.set(e.value.skillId, e.value);
    }

    let summaries: SkillSummary[] = [];
    for (const r of latestBySkillId.values()) {
      if (!includeAll) {
        if (r.name === null) continue;
        if (r.description === "") continue;
        if (r.disabled) continue;
      }
      if (namespace && r.namespace !== namespace) continue;
      if (query) {
        const q = query.toLowerCase();
        const matchesName = r.name?.toLowerCase().includes(q) ?? false;
        const matchesDesc = r.description.toLowerCase().includes(q);
        if (!matchesName && !matchesDesc) continue;
      }
      summaries.push({
        id: r.id,
        skillId: r.skillId,
        namespace: r.namespace,
        name: r.name,
        description: r.description,
        disabled: r.disabled,
        latestVersion: r.version,
        createdAt: new Date(r.createdAt),
        source: typeof r.frontmatter.source === "string" ? r.frontmatter.source : undefined,
      });
    }

    if (sort === "createdAt") {
      summaries = summaries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    } else {
      summaries = summaries.sort(
        (a, b) =>
          a.namespace.localeCompare(b.namespace) || (a.name ?? "").localeCompare(b.name ?? ""),
      );
    }
    return success(summaries);
  }

  async listVersions(namespace: string, name: string): Promise<Result<VersionInfo[], string>> {
    const kv = await this.getKV();
    const skillId = await kv.get<string>(["index", "by_name", namespace, name]);
    if (!skillId) return success([]);
    const versions: VersionInfo[] = [];
    for await (const e of kv.list<SkillRecord>(["skill", skillId])) {
      versions.push({
        version: e.value.version,
        createdAt: new Date(e.value.createdAt),
        createdBy: e.value.createdBy,
      });
    }
    versions.sort((a, b) => b.version - a.version);
    return success(versions);
  }

  // ─── DELETE / DISABLE ─────────────────────────────────────────────────

  async deleteVersion(
    namespace: string,
    name: string,
    version: number,
  ): Promise<Result<void, string>> {
    const kv = await this.getKV();
    const skillId = await kv.get<string>(["index", "by_name", namespace, name]);
    if (!skillId) return success(undefined);

    const record = await kv.get<SkillRecord>(["skill", skillId, String(version)]);
    if (!record) return success(undefined);

    await kv.delete(["skill", skillId, String(version)]);
    await kv.delete(["index", "by_id", record.id]);
    if (record.hasArchive) {
      try {
        const os = await this.getOS();
        await os.delete(this.archiveKey(skillId, version));
      } catch {
        // best-effort
      }
    }
    return success(undefined);
  }

  async setDisabled(skillId: string, disabled: boolean): Promise<Result<void, string>> {
    const kv = await this.getKV();
    for await (const e of kv.list<SkillRecord>(["skill", skillId])) {
      if (e.value.disabled !== disabled) {
        await kv.set(["skill", skillId, String(e.value.version)], { ...e.value, disabled });
      }
    }
    return success(undefined);
  }

  async deleteSkill(skillId: string): Promise<Result<void, string>> {
    const kv = await this.getKV();
    // Drop all per-skill rows + the by_name index entry.
    let lastName: { namespace: string; name: string | null } | null = null;
    for await (const e of kv.list<SkillRecord>(["skill", skillId])) {
      lastName = { namespace: e.value.namespace, name: e.value.name };
      await kv.delete(["skill", skillId, String(e.value.version)]);
      await kv.delete(["index", "by_id", e.value.id]);
      if (e.value.hasArchive) {
        try {
          const os = await this.getOS();
          await os.delete(this.archiveKey(skillId, e.value.version));
        } catch {
          // best-effort
        }
      }
    }
    if (lastName?.name) {
      await kv.delete(["index", "by_name", lastName.namespace, lastName.name]);
    }
    // Drop assignments — workspace-level + job-level.
    for await (const e of kv.list<string>(["assign_ws"])) {
      if (e.key[2] === skillId) await kv.delete([...e.key]);
    }
    for await (const e of kv.list<string>(["assign_job"])) {
      if (e.key[3] === skillId) await kv.delete([...e.key]);
    }
    return success(undefined);
  }

  // ─── ASSIGNMENTS ──────────────────────────────────────────────────────

  async assignSkill(skillId: string, workspaceId: string): Promise<Result<void, string>> {
    const kv = await this.getKV();
    await kv.set<string>(["assign_ws", workspaceId, skillId], "");
    return success(undefined);
  }

  async unassignSkill(skillId: string, workspaceId: string): Promise<Result<void, string>> {
    const kv = await this.getKV();
    await kv.delete(["assign_ws", workspaceId, skillId]);
    return success(undefined);
  }

  async listAssignments(skillId: string): Promise<Result<string[], string>> {
    const kv = await this.getKV();
    const seen = new Set<string>();
    for await (const e of kv.list<string>(["assign_ws"])) {
      if (e.key[2] === skillId) seen.add(String(e.key[1]));
    }
    for await (const e of kv.list<string>(["assign_job"])) {
      if (e.key[3] === skillId) seen.add(String(e.key[1]));
    }
    return success(Array.from(seen));
  }

  async assignToJob(
    skillId: string,
    workspaceId: string,
    jobName: string,
  ): Promise<Result<void, string>> {
    const kv = await this.getKV();
    try {
      await kv.set<string>(["assign_job", workspaceId, jobName, skillId], "");
      return success(undefined);
    } catch (e) {
      return fail(stringifyError(e));
    }
  }

  async unassignFromJob(
    skillId: string,
    workspaceId: string,
    jobName: string,
  ): Promise<Result<void, string>> {
    const kv = await this.getKV();
    try {
      await kv.delete(["assign_job", workspaceId, jobName, skillId]);
      return success(undefined);
    } catch (e) {
      return fail(stringifyError(e));
    }
  }

  async listJobOnlySkillIds(): Promise<Result<string[], string>> {
    const kv = await this.getKV();
    const wsAssigned = new Set<string>();
    for await (const e of kv.list<string>(["assign_ws"])) {
      wsAssigned.add(String(e.key[2]));
    }
    const jobAssigned = new Set<string>();
    for await (const e of kv.list<string>(["assign_job"])) {
      jobAssigned.add(String(e.key[3]));
    }
    const out: string[] = [];
    for (const id of jobAssigned) if (!wsAssigned.has(id)) out.push(id);
    return success(out);
  }

  // ─── SCOPED LISTING ──────────────────────────────────────────────────

  async listAssigned(workspaceId: string): Promise<Result<SkillSummary[], string>> {
    const kv = await this.getKV();
    const skillIds: string[] = [];
    for await (const e of kv.list<string>(["assign_ws", workspaceId])) {
      skillIds.push(String(e.key[2]));
    }
    return this.listByIds(skillIds);
  }

  async listAssignmentsForJob(
    workspaceId: string,
    jobName: string,
  ): Promise<Result<SkillSummary[], string>> {
    const kv = await this.getKV();
    const skillIds: string[] = [];
    for await (const e of kv.list<string>(["assign_job", workspaceId, jobName])) {
      skillIds.push(String(e.key[3]));
    }
    return this.listByIds(skillIds);
  }

  /** Resolve a list of skillIds to summaries, filtering disabled / draft. */
  private async listByIds(skillIds: string[]): Promise<Result<SkillSummary[], string>> {
    const out: SkillSummary[] = [];
    for (const skillId of skillIds) {
      const record = await this.getLatestRecord(skillId);
      if (!record) continue;
      if (record.name === null) continue;
      if (record.description === "") continue;
      if (record.disabled) continue;
      out.push({
        id: record.id,
        skillId: record.skillId,
        namespace: record.namespace,
        name: record.name,
        description: record.description,
        disabled: record.disabled,
        latestVersion: record.version,
        createdAt: new Date(record.createdAt),
        source:
          typeof record.frontmatter.source === "string" ? record.frontmatter.source : undefined,
      });
    }
    out.sort(
      (a, b) =>
        a.namespace.localeCompare(b.namespace) || (a.name ?? "").localeCompare(b.name ?? ""),
    );
    return success(out);
  }
}

/** Wrap a Uint8Array as a ReadableStream<Uint8Array> for Object Store put. */
function readableFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
