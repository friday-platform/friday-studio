import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { cortexRequest } from "@atlas/utils/cortex-http";
import { ulid } from "ulid";
import type { CreateSkillInput, Skill, SkillSummary } from "./schemas.ts";
import type { SkillStorageAdapter } from "./storage.ts";

const logger = createLogger({ name: "cortex-skill-storage" });

export interface CortexSkillMetadata {
  skill_id: string;
  name: string;
  description: string;
  workspace_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
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

  async create(createdBy: string, input: CreateSkillInput): Promise<Result<Skill, string>> {
    try {
      const id = ulid();
      const now = new Date().toISOString();
      // 1. Upload instructions as blob
      const uploadRes = await this.request<{ id: string }>("POST", "/objects", input.instructions);
      if (!uploadRes) return fail("Failed to upload skill content");
      // 2. Set metadata
      const metadata: CortexSkillMetadata = {
        skill_id: id,
        name: input.name,
        description: input.description,
        workspace_id: input.workspaceId,
        created_by: createdBy,
        created_at: now,
        updated_at: now,
      };
      await this.request("POST", `/objects/${uploadRes.id}/metadata`, metadata);
      return success({
        id,
        ...input,
        createdBy,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
    } catch (error) {
      logger.error("Failed to create skill", { error: stringifyError(error) });
      return fail(stringifyError(error));
    }
  }

  async get(id: string): Promise<Result<Skill | null, string>> {
    try {
      const objects = await this.request<CortexObject[]>("GET", `/objects?metadata.skill_id=${id}`);
      const obj = objects?.[0];
      if (!obj) return success(null);
      const instructions = await this.request<string>(
        "GET",
        `/objects/${obj.id}`,
        undefined,
        false,
      );
      if (!instructions) return fail("Failed to load skill content");
      return success(this.toSkill(obj.metadata, instructions));
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async getByName(name: string, workspaceId: string): Promise<Result<Skill | null, string>> {
    try {
      const url = `/objects?metadata.name=${encodeURIComponent(name)}&metadata.workspace_id=${encodeURIComponent(workspaceId)}`;
      const objects = await this.request<CortexObject[]>("GET", url);
      const obj = objects?.[0];
      if (!obj) return success(null);
      const instructions = await this.request<string>(
        "GET",
        `/objects/${obj.id}`,
        undefined,
        false,
      );
      if (!instructions) return fail("Failed to load skill content");
      return success(this.toSkill(obj.metadata, instructions));
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async list(workspaceId: string): Promise<Result<SkillSummary[], string>> {
    try {
      const objects = await this.request<CortexObject[]>(
        "GET",
        `/objects?metadata.workspace_id=${encodeURIComponent(workspaceId)}`,
      );
      if (!objects) return success([]);
      return success(
        objects.map((o) => ({ name: o.metadata.name, description: o.metadata.description })),
      );
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async update(id: string, input: Partial<CreateSkillInput>): Promise<Result<Skill, string>> {
    try {
      const existing = await this.get(id);
      if (!existing.ok) return existing;
      if (!existing.data) return fail("Skill not found");
      // Find cortex object and update
      const objects = await this.request<CortexObject[]>("GET", `/objects?metadata.skill_id=${id}`);
      const obj = objects?.[0];
      if (!obj) return fail("Skill not found");
      const now = new Date().toISOString();
      if (input.instructions) {
        await this.request("PUT", `/objects/${obj.id}`, input.instructions);
      }
      // Map camelCase input fields to snake_case metadata fields
      const updates: Partial<CortexSkillMetadata> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.description !== undefined) updates.description = input.description;
      if (input.workspaceId !== undefined) updates.workspace_id = input.workspaceId;
      const newMeta = { ...obj.metadata, ...updates, updated_at: now };
      await this.request("POST", `/objects/${obj.id}/metadata`, newMeta);
      const instructions =
        input.instructions ??
        (await this.request<string>("GET", `/objects/${obj.id}`, undefined, false)) ??
        "";
      return success(this.toSkill(newMeta, instructions));
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async delete(id: string): Promise<Result<void, string>> {
    try {
      const objects = await this.request<CortexObject[]>("GET", `/objects?metadata.skill_id=${id}`);
      if (objects)
        await Promise.all(objects.map((o) => this.request("DELETE", `/objects/${o.id}`)));
      return success(undefined);
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  private toSkill(m: CortexSkillMetadata, instructions: string): Skill {
    return {
      id: m.skill_id,
      name: m.name,
      description: m.description,
      instructions,
      workspaceId: m.workspace_id,
      createdBy: m.created_by,
      createdAt: new Date(m.created_at),
      updatedAt: new Date(m.updated_at),
    };
  }
}
