import { Buffer } from "node:buffer";
import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { cortexRequest } from "@atlas/utils/cortex-http";
import { customAlphabet } from "nanoid";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 16);

import { ulid } from "ulid";
import { z } from "zod";
import type { PublishSkillInput, Skill, SkillSort, SkillSummary, VersionInfo } from "./schemas.ts";
import type { SkillStorageAdapter } from "./storage.ts";

const logger = createLogger({ name: "cortex-skill-storage" });

const FrontmatterSchema = z.record(z.string(), z.unknown());

/**
 * Cortex metadata for the primary skill blob (instructions + metadata).
 * Archive blobs use the same shape but with `type: "archive"`.
 */
export interface CortexSkillMetadata {
  skill_id: string;
  namespace: string;
  name: string;
  version: number;
  description: string;
  frontmatter: string; // JSON-encoded
  created_by: string;
  created_at: string;
  /** Discriminator: "skill" for primary blob, "archive" for archive blob */
  type: "skill" | "archive";
  /** True for the highest-version skill blob per (namespace, name) */
  is_latest: boolean;
  disabled?: boolean;
  description_manual?: boolean;
}

export interface CortexObject {
  id: string;
  metadata: CortexSkillMetadata;
}

export class CortexSkillAdapter implements SkillStorageAdapter {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    parseJson = true,
  ): Promise<T | null> {
    return cortexRequest<T>(this.baseUrl, method, endpoint, body, { parseJson });
  }

  async create(namespace: string, createdBy: string): Promise<Result<{ skillId: string }, string>> {
    try {
      const skillId = nanoid();
      const now = new Date().toISOString();

      const uploadRes = await this.request<{ id: string }>("POST", "/objects", "");
      if (!uploadRes) return fail("Failed to create skill object");

      const metadata: CortexSkillMetadata = {
        skill_id: skillId,
        namespace,
        name: "",
        version: 1,
        description: "",
        frontmatter: "{}",
        created_by: createdBy,
        created_at: now,
        type: "skill",
        is_latest: true,
      };
      await this.request("POST", `/objects/${uploadRes.id}/metadata`, metadata);

      return success({ skillId });
    } catch (error) {
      logger.error("Failed to create skill", { error: stringifyError(error) });
      return fail(stringifyError(error));
    }
  }

  async publish(
    namespace: string,
    name: string,
    createdBy: string,
    input: PublishSkillInput,
  ): Promise<Result<{ id: string; version: number; name: string; skillId: string }, string>> {
    try {
      // KNOWN RACE: concurrent publishes can compute the same version number.
      // Cortex has no server-side uniqueness constraint on (namespace, name, version).
      // Best-effort: is_latest swap ensures only one version is "latest".
      // Acceptable for single-operator use; add retry-on-conflict if publish volume grows.
      let skillId = input.skillId;
      const currentLatest = await this.findLatestObject(namespace, name);
      if (!skillId) {
        skillId = currentLatest?.metadata.skill_id ?? ulid();
      }
      const version = currentLatest ? currentLatest.metadata.version + 1 : 1;
      const id = ulid();
      const now = new Date().toISOString();

      const uploadRes = await this.request<{ id: string }>("POST", "/objects", input.instructions);
      if (!uploadRes) return fail("Failed to upload skill content");

      // is_latest=false initially — safe intermediate state during version swap
      const metadata: CortexSkillMetadata = {
        skill_id: skillId,
        namespace,
        name,
        version,
        description: input.description ?? "",
        frontmatter: JSON.stringify(input.frontmatter ?? {}),
        created_by: createdBy,
        created_at: now,
        type: "skill",
        is_latest: !currentLatest, // true for first version, false during swap
        description_manual: input.descriptionManual === true ? true : undefined,
      };
      await this.request("POST", `/objects/${uploadRes.id}/metadata`, metadata);

      if (input.archive) {
        const archiveBlob = Buffer.from(input.archive).toString("base64");
        const archiveRes = await this.request<{ id: string }>("POST", "/objects", archiveBlob);
        if (!archiveRes) return fail("Failed to upload skill archive");

        const archiveMeta: CortexSkillMetadata = {
          skill_id: skillId,
          namespace,
          name,
          version,
          description: input.description ?? "",
          frontmatter: "{}",
          created_by: createdBy,
          created_at: now,
          type: "archive",
          is_latest: false, // archive blobs are never "latest"
        };
        await this.request("POST", `/objects/${archiveRes.id}/metadata`, archiveMeta);
      }

      // Best-effort swap: unmark old latest, promote new
      if (currentLatest) {
        try {
          const oldMeta: CortexSkillMetadata = { ...currentLatest.metadata, is_latest: false };
          await this.request("POST", `/objects/${currentLatest.id}/metadata`, oldMeta);
        } catch (error) {
          // Old is still latest, new is is_latest=false — consistent, just promote new
          logger.error("Failed to unmark old version, promoting new directly", {
            error: stringifyError(error),
          });
        }

        try {
          const finalMeta: CortexSkillMetadata = { ...metadata, is_latest: true };
          await this.request("POST", `/objects/${uploadRes.id}/metadata`, finalMeta);
        } catch (error) {
          // Both old and new may be is_latest=false — try to restore old
          logger.error("Failed to mark new version as latest, attempting rollback", {
            error: stringifyError(error),
          });
          try {
            const restoreMeta: CortexSkillMetadata = { ...currentLatest.metadata, is_latest: true };
            await this.request("POST", `/objects/${currentLatest.id}/metadata`, restoreMeta);
          } catch (rollbackError) {
            logger.error("CRITICAL: Failed to rollback is_latest after swap failure", {
              error: stringifyError(rollbackError),
            });
          }
          return fail(`Failed to mark new version as latest: ${stringifyError(error)}`);
        }
      }

      return success({ id, version, name, skillId });
    } catch (error) {
      logger.error("Failed to publish skill", { error: stringifyError(error) });
      return fail(stringifyError(error));
    }
  }

  async get(
    namespace: string,
    name: string,
    version?: number,
  ): Promise<Result<Skill | null, string>> {
    try {
      const obj = await this.findSkillObject(namespace, name, version);
      if (!obj) return success(null);

      const instructions = await this.request<string>(
        "GET",
        `/objects/${obj.id}`,
        undefined,
        false,
      );
      if (instructions === null) return fail("Failed to load skill content");

      const archive = await this.loadArchive(obj.metadata.skill_id);

      return success(this.toSkill(obj.metadata, instructions, archive));
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async getById(id: string): Promise<Result<Skill | null, string>> {
    try {
      const url = `/objects?metadata.type=skill&metadata.skill_id=${encodeURIComponent(id)}`;
      const objects = await this.request<CortexObject[]>("GET", url);
      const obj = objects?.[0];
      if (!obj) return success(null);

      const instructions = await this.request<string>(
        "GET",
        `/objects/${obj.id}`,
        undefined,
        false,
      );
      if (instructions === null) return fail("Failed to load skill content");

      const archive = await this.loadArchive(obj.metadata.skill_id);
      return success(this.toSkill(obj.metadata, instructions, archive));
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  getBySkillId(skillId: string): Promise<Result<Skill | null, string>> {
    return this.getById(skillId);
  }

  async list(
    namespace?: string,
    query?: string,
    includeAll?: boolean,
    sort: SkillSort = "name",
  ): Promise<Result<SkillSummary[], string>> {
    try {
      // Filter by type=skill and is_latest=true — server-side dedup
      let url = "/objects?metadata.type=skill&metadata.is_latest=true";
      if (namespace) {
        url += `&metadata.namespace=${encodeURIComponent(namespace)}`;
      }

      const objects = await this.request<CortexObject[]>("GET", url);
      if (!objects) return success([]);

      let summaries: SkillSummary[] = objects.map((o) => ({
        id: o.metadata.skill_id,
        skillId: o.metadata.skill_id,
        namespace: o.metadata.namespace,
        name: o.metadata.name,
        description: o.metadata.description,
        disabled: o.metadata.disabled === true,
        latestVersion: o.metadata.version,
        createdAt: new Date(o.metadata.created_at),
      }));

      if (!includeAll) {
        summaries = summaries.filter((s) => s.name && s.description !== "" && !s.disabled);
      }

      if (query) {
        const q = query.toLowerCase();
        summaries = summaries.filter(
          (s) =>
            (s.name ?? "").toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
        );
      }

      if (sort === "createdAt") {
        summaries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      } else {
        summaries.sort((a, b) => {
          const ns = a.namespace.localeCompare(b.namespace);
          if (ns !== 0) return ns;
          return (a.name ?? "").localeCompare(b.name ?? "");
        });
      }

      return success(summaries);
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async listVersions(namespace: string, name: string): Promise<Result<VersionInfo[], string>> {
    try {
      const url = `/objects?metadata.type=skill&metadata.namespace=${encodeURIComponent(
        namespace,
      )}&metadata.name=${encodeURIComponent(name)}`;
      const objects = await this.request<CortexObject[]>("GET", url);
      if (!objects) return success([]);

      const versions: VersionInfo[] = objects
        .map((o) => ({
          version: o.metadata.version,
          createdAt: new Date(o.metadata.created_at),
          createdBy: o.metadata.created_by,
        }))
        .sort((a, b) => b.version - a.version);

      return success(versions);
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async deleteVersion(
    namespace: string,
    name: string,
    version: number,
  ): Promise<Result<void, string>> {
    try {
      // Omits type filter to delete both skill and archive blobs for this version
      const url = `/objects?metadata.namespace=${encodeURIComponent(
        namespace,
      )}&metadata.name=${encodeURIComponent(name)}&metadata.version=${version}`;
      const objects = await this.request<CortexObject[]>("GET", url);
      if (!objects || objects.length === 0) return success(undefined);

      const wasLatest = objects.some((o) => o.metadata.type === "skill" && o.metadata.is_latest);

      await Promise.all(objects.map((o) => this.request("DELETE", `/objects/${o.id}`)));

      // If we deleted the latest version, promote the next-highest so list() still finds this skill
      if (wasLatest) {
        const remaining = await this.request<CortexObject[]>(
          "GET",
          `/objects?metadata.type=skill&metadata.namespace=${encodeURIComponent(
            namespace,
          )}&metadata.name=${encodeURIComponent(name)}`,
        );
        const first = remaining?.[0];
        if (first) {
          let best = first;
          for (const obj of remaining) {
            if (obj.metadata.version > best.metadata.version) best = obj;
          }
          await this.request("POST", `/objects/${best.id}/metadata`, {
            ...best.metadata,
            is_latest: true,
          });
        }
      }

      return success(undefined);
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async setDisabled(skillId: string, disabled: boolean): Promise<Result<void, string>> {
    try {
      const url = `/objects?metadata.type=skill&metadata.skill_id=${encodeURIComponent(skillId)}`;
      const objects = await this.request<CortexObject[]>("GET", url);
      if (!objects) return success(undefined);

      await Promise.all(
        objects.map((o) =>
          this.request("POST", `/objects/${o.id}/metadata`, { ...o.metadata, disabled }),
        ),
      );
      return success(undefined);
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async deleteSkill(skillId: string): Promise<Result<void, string>> {
    try {
      const url = `/objects?metadata.skill_id=${encodeURIComponent(skillId)}`;
      const objects = await this.request<CortexObject[]>("GET", url);
      if (!objects) return success(undefined);

      await Promise.all(objects.map((o) => this.request("DELETE", `/objects/${o.id}`)));
      return success(undefined);
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  // ---------------------------------------------------------------------------
  // Assignments — not implemented for Cortex (unused in prod)
  // ---------------------------------------------------------------------------

  listUnassigned(): Promise<Result<SkillSummary[], string>> {
    return this.list();
  }
  listAssigned(): Promise<Result<SkillSummary[], string>> {
    return Promise.resolve(success([]));
  }
  assignSkill(): Promise<Result<void, string>> {
    return Promise.resolve(fail("CortexSkillAdapter does not support assignSkill"));
  }
  unassignSkill(): Promise<Result<void, string>> {
    return Promise.resolve(fail("CortexSkillAdapter does not support unassignSkill"));
  }
  listAssignments(): Promise<Result<string[], string>> {
    return Promise.resolve(success([]));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Find the is_latest=true skill object for a (namespace, name) pair.
   */
  private async findLatestObject(namespace: string, name: string): Promise<CortexObject | null> {
    const url = `/objects?metadata.type=skill&metadata.namespace=${encodeURIComponent(
      namespace,
    )}&metadata.name=${encodeURIComponent(name)}&metadata.is_latest=true`;
    const objects = await this.request<CortexObject[]>("GET", url);
    return objects?.[0] ?? null;
  }

  /**
   * Find the primary skill object. If version is omitted, returns the latest.
   */
  private async findSkillObject(
    namespace: string,
    name: string,
    version?: number,
  ): Promise<CortexObject | null> {
    if (version !== undefined) {
      const url = `/objects?metadata.type=skill&metadata.namespace=${encodeURIComponent(
        namespace,
      )}&metadata.name=${encodeURIComponent(name)}&metadata.version=${version}`;
      const objects = await this.request<CortexObject[]>("GET", url);
      return objects?.[0] ?? null;
    }

    const result = await this.findLatestObject(namespace, name);
    if (result) return result;

    // Fallback: race window during publish swap — both objects may have is_latest=false
    logger.debug("is_latest query returned empty, falling back to version ordering", {
      namespace,
      name,
    });
    const fallbackUrl = `/objects?metadata.type=skill&metadata.namespace=${encodeURIComponent(
      namespace,
    )}&metadata.name=${encodeURIComponent(name)}`;
    const objects = await this.request<CortexObject[]>("GET", fallbackUrl);
    if (!objects || objects.length === 0) return null;

    let best: CortexObject | null = null;
    for (const obj of objects) {
      if (!best || obj.metadata.version > best.metadata.version) {
        best = obj;
      }
    }
    return best;
  }

  /**
   * Load the archive blob for a skill (by skill_id).
   */
  private async loadArchive(skillId: string): Promise<Uint8Array | null> {
    const url = `/objects?metadata.skill_id=${encodeURIComponent(skillId)}&metadata.type=archive`;
    const objects = await this.request<CortexObject[]>("GET", url);
    if (!objects || objects.length === 0) return null;

    const archiveObj = objects[0];
    if (!archiveObj) return null;

    const raw = await this.request<string>("GET", `/objects/${archiveObj.id}`, undefined, false);
    if (raw === null) return null;

    return Buffer.from(raw, "base64");
  }

  private toSkill(m: CortexSkillMetadata, instructions: string, archive: Uint8Array | null): Skill {
    return {
      id: m.skill_id,
      skillId: m.skill_id,
      namespace: m.namespace,
      name: m.name,
      version: m.version,
      description: m.description,
      descriptionManual: m.description_manual === true,
      disabled: m.disabled === true,
      frontmatter: FrontmatterSchema.parse(JSON.parse(m.frontmatter)),
      instructions,
      archive: archive ? new Uint8Array(archive) : null,
      createdBy: m.created_by,
      createdAt: new Date(m.created_at),
    };
  }
}
