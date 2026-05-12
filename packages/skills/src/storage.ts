import { createLogger } from "@atlas/logger";
import type { Result } from "@atlas/utils";
import type { NatsConnection } from "nats";
import { JetStreamSkillAdapter, type SkillReplayer } from "./jetstream-adapter.ts";
import type { PublishSkillInput, Skill, SkillSort, SkillSummary, VersionInfo } from "./schemas.ts";

const logger = createLogger({ name: "skill-storage" });

export { SYSTEM_USER_ID } from "./constants.ts";

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
 * Throws if neither `initSkillStorage(nc)` nor
 * `_setSkillStorageForTest()` has been called. A missing init is a
 * daemon-wiring bug; falling back to an in-process / on-disk SQLite
 * shim would silently fork the skill catalog away from the broker
 * and lose every published skill on restart.
 */
let _storage: SkillStorageAdapter | null = null;
let _replayer: SkillReplayer | null = null;

export function initSkillStorage(nc: NatsConnection): void {
  const adapter = new JetStreamSkillAdapter(nc);
  _storage = adapter;
  _replayer = adapter;
  logger.info("Skill storage initialized (JetStream)");
}

/**
 * Inject a custom adapter — tests only. Accepts the narrow
 * `SkillStorageAdapter` so unrelated tests can pass minimal mocks without
 * stubbing `replayVersion`. Tests that exercise replay-using code paths
 * must wire a real `JetStreamSkillAdapter` via the in-process NATS harness
 * rather than this seam.
 */
export function _setSkillStorageForTest(adapter: SkillStorageAdapter | null): void {
  _storage = adapter;
}

function getStorage(): SkillStorageAdapter {
  if (!_storage) {
    throw new Error(
      "Skill storage not initialized — call initSkillStorage(nc) at daemon startup, " +
        "or _setSkillStorageForTest(adapter) in tests.",
    );
  }
  return _storage;
}

function getReplayer(): SkillReplayer {
  if (!_replayer) {
    throw new Error(
      "SkillReplayer not initialized — replay-using tests must use a real " +
        "JetStreamSkillAdapter via the NATS test harness, not _setSkillStorageForTest.",
    );
  }
  return _replayer;
}

/**
 * Lazily-initialized skill storage adapter.
 * Defers adapter creation until first method call, allowing tests to
 * configure environment variables before initialization.
 */
export const SkillStorage: SkillStorageAdapter & SkillReplayer = {
  create: (...args) => getStorage().create(...args),
  publish: (...args) => getStorage().publish(...args),
  replayVersion: (...args) => getReplayer().replayVersion(...args),
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
