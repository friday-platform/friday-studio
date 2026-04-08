import process from "node:process";
import { createLogger } from "@atlas/logger";
import type { Result } from "@atlas/utils";
import { CortexSkillAdapter } from "./cortex-adapter.ts";
import { LocalSkillAdapter } from "./local-adapter.ts";
import type { PublishSkillInput, Skill, SkillSort, SkillSummary, VersionInfo } from "./schemas.ts";

const logger = createLogger({ name: "skill-storage" });

export interface SkillStorageAdapter {
  create(namespace: string, createdBy: string): Promise<Result<{ skillId: string }, string>>;
  publish(
    namespace: string,
    name: string,
    createdBy: string,
    input: PublishSkillInput,
  ): Promise<Result<{ id: string; version: number; name: string; skillId: string }, string>>;
  get(namespace: string, name: string, version?: number): Promise<Result<Skill | null, string>>;
  getById(id: string): Promise<Result<Skill | null, string>>;
  getBySkillId(skillId: string): Promise<Result<Skill | null, string>>;
  list(
    namespace?: string,
    query?: string,
    includeAll?: boolean,
    sort?: SkillSort,
  ): Promise<Result<SkillSummary[], string>>;
  listVersions(namespace: string, name: string): Promise<Result<VersionInfo[], string>>;
  deleteVersion(namespace: string, name: string, version: number): Promise<Result<void, string>>;
  setDisabled(skillId: string, disabled: boolean): Promise<Result<void, string>>;
  deleteSkill(skillId: string): Promise<Result<void, string>>;

  // Scoped listing
  /** Skills with no assignments — visible to every workspace. */
  listUnassigned(): Promise<Result<SkillSummary[], string>>;
  /** Skills explicitly assigned to the given workspace. */
  listAssigned(workspaceId: string): Promise<Result<SkillSummary[], string>>;

  // Direct assignments
  assignSkill(skillId: string, workspaceId: string): Promise<Result<void, string>>;
  unassignSkill(skillId: string, workspaceId: string): Promise<Result<void, string>>;
  listAssignments(skillId: string): Promise<Result<string[], string>>;
}

function createSkillStorageAdapter(): SkillStorageAdapter {
  const adapterType = process.env.SKILL_STORAGE_ADAPTER || "local";
  switch (adapterType) {
    case "local": {
      const dbPath = process.env.SKILL_LOCAL_DB_PATH;
      logger.info("Using LocalSkillAdapter", { dbPath });
      return new LocalSkillAdapter(dbPath);
    }
    case "cortex": {
      const cortexUrl = process.env.CORTEX_URL;
      if (!cortexUrl) {
        throw new Error("CORTEX_URL required when SKILL_STORAGE_ADAPTER=cortex");
      }
      logger.info("Using CortexSkillAdapter", { cortexUrl });
      return new CortexSkillAdapter(cortexUrl);
    }
    default:
      throw new Error(`Unknown skill storage adapter: ${adapterType}`);
  }
}

let _storage: SkillStorageAdapter | null = null;

function getStorage(): SkillStorageAdapter {
  if (!_storage) {
    _storage = createSkillStorageAdapter();
  }
  return _storage;
}

/**
 * Lazily-initialized skill storage adapter.
 * Defers adapter creation until first method call, allowing tests to
 * configure environment variables before initialization.
 */
export const SkillStorage: SkillStorageAdapter = {
  create: (...args) => getStorage().create(...args),
  publish: (...args) => getStorage().publish(...args),
  get: (...args) => getStorage().get(...args),
  getById: (...args) => getStorage().getById(...args),
  getBySkillId: (...args) => getStorage().getBySkillId(...args),
  list: (...args) => getStorage().list(...args),
  listVersions: (...args) => getStorage().listVersions(...args),
  deleteVersion: (...args) => getStorage().deleteVersion(...args),
  setDisabled: (...args) => getStorage().setDisabled(...args),
  deleteSkill: (...args) => getStorage().deleteSkill(...args),
  listUnassigned: (...args) => getStorage().listUnassigned(...args),
  listAssigned: (...args) => getStorage().listAssigned(...args),
  assignSkill: (...args) => getStorage().assignSkill(...args),
  unassignSkill: (...args) => getStorage().unassignSkill(...args),
  listAssignments: (...args) => getStorage().listAssignments(...args),
};
