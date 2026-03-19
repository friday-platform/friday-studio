// Schemas and types

// Ledger HTTP client
export { createActivityLedgerClient } from "./ledger-client.ts";
// Local adapter (for direct instantiation in tests)
export { LocalActivityAdapter } from "./local-adapter.ts";
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

// Title generators
export type {
  GenerateResourceActivityTitleInput,
  GenerateSessionActivityTitleInput,
  UserActivityAction,
} from "./title-generator.ts";
export {
  generateResourceActivityTitle,
  generateSessionActivityTitle,
  generateUserActivityTitle,
  kebabToSentenceCase,
} from "./title-generator.ts";
