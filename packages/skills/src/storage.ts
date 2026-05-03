import process from "node:process";
import { createLogger } from "@atlas/logger";
import type { Result } from "@atlas/utils";
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
  /** Skills explicitly assigned to the given workspace. */
  listAssigned(workspaceId: string): Promise<Result<SkillSummary[], string>>;

  // Direct assignments
  assignSkill(skillId: string, workspaceId: string): Promise<Result<void, string>>;
  unassignSkill(skillId: string, workspaceId: string): Promise<Result<void, string>>;
  listAssignments(skillId: string): Promise<Result<string[], string>>;

  // Job-level assignments — additive to workspace-level.
  // `(workspaceId, jobName)` forms the scope; jobs in the same workspace
  // cannot see each other's assigned skills.
  assignToJob(skillId: string, workspaceId: string, jobName: string): Promise<Result<void, string>>;
  unassignFromJob(
    skillId: string,
    workspaceId: string,
    jobName: string,
  ): Promise<Result<void, string>>;
  /** Skills assigned *only* to (workspaceId, jobName). Workspace-level rows excluded. */
  listAssignmentsForJob(
    workspaceId: string,
    jobName: string,
  ): Promise<Result<SkillSummary[], string>>;
  /**
   * Skill IDs that exist *only* as job-level assignments (no workspace-level
   * row anywhere). These are scoped private to their owning (workspace, job)
   * and must be excluded from the otherwise-global catalog pool used by
   * `resolveVisibleSkills`. Without this filter, a skill assigned only to
   * (ws-1, job-a) would leak into ws-2 / job-b via the catalog.
   */
  listJobOnlySkillIds(): Promise<Result<string[], string>>;
}

/**
 * Local-only since the Cortex variant was deleted 2026-05-02 (speculative
 * remote backend, never reached). The `SKILL_STORAGE_ADAPTER` env var is
 * no longer consulted; skills live in `${FRIDAY_HOME}/skills.db` (override
 * with `SKILL_LOCAL_DB_PATH`). Future skills migration story is tracked
 * separately — see the plan's "Skills migration" task.
 */
function createSkillStorageAdapter(): SkillStorageAdapter {
  const dbPath = process.env.SKILL_LOCAL_DB_PATH;
  logger.info("Using LocalSkillAdapter", { dbPath });
  return new LocalSkillAdapter(dbPath);
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

  listAssigned: (...args) => getStorage().listAssigned(...args),
  assignSkill: (...args) => getStorage().assignSkill(...args),
  unassignSkill: (...args) => getStorage().unassignSkill(...args),
  listAssignments: (...args) => getStorage().listAssignments(...args),
  assignToJob: (...args) => getStorage().assignToJob(...args),
  unassignFromJob: (...args) => getStorage().unassignFromJob(...args),
  listAssignmentsForJob: (...args) => getStorage().listAssignmentsForJob(...args),
  listJobOnlySkillIds: (...args) => getStorage().listJobOnlySkillIds(...args),
};
