import process from "node:process";
import { createLogger } from "@atlas/logger";
import type { Result } from "@atlas/utils";
import type { NatsConnection } from "nats";
import { JetStreamSkillAdapter } from "./jetstream-adapter.ts";
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
 * Skill storage facade. Production daemon calls `initSkillStorage(nc)`
 * at startup so both bundled-skill bootstrap (`packages/system/skills/`)
 * and `atlas skill publish` writes land in the same JetStream `SKILLS`
 * KV bucket + `SKILL_ARCHIVES` Object Store.
 *
 * If init is never called, a `LocalSkillAdapter` (SQLite at
 * `${FRIDAY_HOME}/skills.db`) is used as a fallback. This keeps
 * unit tests working without per-test NATS wiring; tests that want
 * deterministic isolation should set `SKILL_LOCAL_DB_PATH` to a tmp
 * file or call `_setSkillStorageForTest()`.
 */
let _storage: SkillStorageAdapter | null = null;

export function initSkillStorage(nc: NatsConnection): void {
  _storage = new JetStreamSkillAdapter(nc);
  logger.info("Skill storage initialized (JetStream)");
}

/** Inject a custom adapter — tests only. */
export function _setSkillStorageForTest(adapter: SkillStorageAdapter | null): void {
  _storage = adapter;
}

function getStorage(): SkillStorageAdapter {
  if (!_storage) {
    const dbPath = process.env.SKILL_LOCAL_DB_PATH;
    logger.info("Skill storage falling back to LocalSkillAdapter (SQLite)", { dbPath });
    _storage = new LocalSkillAdapter(dbPath);
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
