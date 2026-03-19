import { ActivityNotifier } from "./notifier.ts";
import type {
  Activity,
  ActivityListFilter,
  ActivityWithReadStatus,
  CreateActivityInput,
  ReadStatusValue,
} from "./schemas.ts";

export interface ActivityListResult {
  activities: ActivityWithReadStatus[];
  hasMore: boolean;
}

export interface ActivityStorageAdapter {
  create(input: CreateActivityInput): Promise<Activity>;
  deleteByReferenceId(referenceId: string): Promise<void>;
  list(userId: string, filters?: ActivityListFilter): Promise<ActivityListResult>;
  getUnreadCount(userId: string): Promise<number>;
  updateReadStatus(userId: string, activityIds: string[], status: ReadStatusValue): Promise<void>;
  markViewedBefore(userId: string, before: string): Promise<void>;
}

export const activityNotifier = new ActivityNotifier();
