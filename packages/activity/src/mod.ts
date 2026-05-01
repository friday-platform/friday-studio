// NOTE: This barrel is imported by the ledger Docker build, which does NOT copy
// packages/llm/ or packages/core/. Do not re-export from title-generator.ts or
// any module that transitively pulls @atlas/llm or @atlas/core.

// Ledger HTTP client
export { createActivityLedgerClient } from "./ledger-client.ts";
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
