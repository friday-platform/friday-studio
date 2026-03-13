// Schemas and types

// Local adapter (for direct instantiation in tests)
export { LocalActivityAdapter } from "./local-adapter.ts";
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
export { ActivityStorage } from "./storage.ts";

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
} from "./title-generator.ts";
