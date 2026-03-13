import process from "node:process";
import { createLogger } from "@atlas/logger";
import { LocalActivityAdapter } from "./local-adapter.ts";
import type {
  Activity,
  ActivityListFilter,
  ActivityWithReadStatus,
  CreateActivityInput,
  ReadStatusValue,
} from "./schemas.ts";

const logger = createLogger({ name: "activity-storage" });

export interface ActivityListResult {
  activities: ActivityWithReadStatus[];
  hasMore: boolean;
}

export interface ActivityStorageAdapter {
  create(input: CreateActivityInput): Promise<Activity>;
  list(userId: string, filters?: ActivityListFilter): Promise<ActivityListResult>;
  getUnreadCount(userId: string): Promise<number>;
  updateReadStatus(userId: string, activityIds: string[], status: ReadStatusValue): Promise<void>;
  markViewedBefore(userId: string, before: string): Promise<void>;
}

function createActivityStorageAdapter(): ActivityStorageAdapter {
  const adapterType = process.env.ACTIVITY_STORAGE_ADAPTER || "local";
  switch (adapterType) {
    case "local": {
      const dbPath = process.env.ACTIVITY_LOCAL_DB_PATH;
      logger.info("Using LocalActivityAdapter", { dbPath });
      return new LocalActivityAdapter(dbPath);
    }
    default:
      throw new Error(`Unknown activity storage adapter: ${adapterType}`);
  }
}

let _storage: ActivityStorageAdapter | null = null;

function getStorage(): ActivityStorageAdapter {
  if (!_storage) {
    _storage = createActivityStorageAdapter();
  }
  return _storage;
}

/**
 * Lazily-initialized activity storage adapter.
 * Defers adapter creation until first method call, allowing tests to
 * configure environment variables before initialization.
 */
export const ActivityStorage: ActivityStorageAdapter = {
  create: (input) => getStorage().create(input),
  list: (userId, filters) => getStorage().list(userId, filters),
  getUnreadCount: (userId) => getStorage().getUnreadCount(userId),
  updateReadStatus: (userId, activityIds, status) =>
    getStorage().updateReadStatus(userId, activityIds, status),
  markViewedBefore: (userId, before) => getStorage().markViewedBefore(userId, before),
};
