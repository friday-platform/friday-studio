import process from "node:process";
import { createLogger } from "@atlas/logger";
import type { Result } from "@atlas/utils";
import { CortexSkillAdapter } from "./cortex-adapter.ts";
import { LocalSkillAdapter } from "./local-adapter.ts";
import type { CreateSkillInput, Skill, SkillSummary } from "./schemas.ts";

const logger = createLogger({ name: "skill-storage" });

export interface SkillStorageAdapter {
  create(createdBy: string, input: CreateSkillInput): Promise<Result<Skill, string>>;
  update(id: string, input: Partial<CreateSkillInput>): Promise<Result<Skill, string>>;
  get(id: string): Promise<Result<Skill | null, string>>;
  getByName(name: string, workspaceId: string): Promise<Result<Skill | null, string>>;
  list(workspaceId: string): Promise<Result<SkillSummary[], string>>;
  delete(id: string): Promise<Result<void, string>>;
}

function createSkillStorageAdapter(): SkillStorageAdapter {
  const adapterType = process.env.SKILL_STORAGE_ADAPTER || "local";
  switch (adapterType) {
    case "local":
      logger.info("Using LocalSkillAdapter");
      return new LocalSkillAdapter();
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
 * Uses a Proxy to defer adapter creation until first method call,
 * allowing tests to configure environment variables before initialization.
 */
export const SkillStorage: SkillStorageAdapter = new Proxy({} as SkillStorageAdapter, {
  get(_target, prop: keyof SkillStorageAdapter) {
    const storage = getStorage();
    const value = storage[prop];
    // Bind methods to the storage instance so `this` works correctly
    if (typeof value === "function") {
      return value.bind(storage);
    }
    return value;
  },
  set(_target, prop: keyof SkillStorageAdapter, value: unknown) {
    if (typeof value !== "function") {
      throw new Error(`SkillStorage.${prop} can only be set to a function`);
    }
    const storage = getStorage();
    // Safe to use Object.assign for method replacement (testing/mocking)
    Object.assign(storage, { [prop]: value });
    return true;
  },
});
