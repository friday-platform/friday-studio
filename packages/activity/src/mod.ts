// NOTE: This barrel intentionally avoids title-generator.ts / anything that
// transitively pulls @atlas/llm or @atlas/core, so it stays lightweight for
// downstream consumers that only need types and the local SQLite adapter.

// Notifier
export { ActivityNotifier } from "./notifier.ts";
export type {
  Activity,
  ActivityListFilter,
  ActivityReadStatus,
  ActivitySource,
  ActivityType,
  ActivityWithReadStatus,
  CreateActivityInput,
  ReadStatusValue,
} from "./schemas.ts";
export {
  ActivityListFilterSchema,
  ActivityReadStatusSchema,
  ActivitySchema,
  ActivitySourceSchema,
  ActivityTypeSchema,
  ActivityWithReadStatusSchema,
  CreateActivityInputSchema,
  ReadStatusValueSchema,
} from "./schemas.ts";
// Storage
export type { ActivityListResult, ActivityStorageAdapter } from "./storage.ts";
export { activityNotifier } from "./storage.ts";
