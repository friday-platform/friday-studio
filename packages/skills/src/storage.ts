import process from "node:process";
import { createLogger } from "@atlas/logger";
import type { Result } from "@atlas/utils";
import { CortexSkillAdapter } from "./cortex-adapter.ts";
import { LocalSkillAdapter } from "./local-adapter.ts";
import type { PublishSkillInput, Skill, SkillSummary, VersionInfo } from "./schemas.ts";

const logger = createLogger({ name: "skill-storage" });

export interface SkillStorageAdapter {
  publish(
    namespace: string,
    name: string,
    createdBy: string,
    input: PublishSkillInput,
  ): Promise<Result<{ id: string; version: number }, string>>;
  get(namespace: string, name: string, version?: number): Promise<Result<Skill | null, string>>;
  list(namespace?: string, query?: string): Promise<Result<SkillSummary[], string>>;
  listVersions(namespace: string, name: string): Promise<Result<VersionInfo[], string>>;
  deleteVersion(namespace: string, name: string, version: number): Promise<Result<void, string>>;
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
  publish: (...args) => getStorage().publish(...args),
  get: (...args) => getStorage().get(...args),
  list: (...args) => getStorage().list(...args),
  listVersions: (...args) => getStorage().listVersions(...args),
  deleteVersion: (...args) => getStorage().deleteVersion(...args),
};
