import { truncateUnicode } from "@atlas/utils";

export const MAX_TITLE_LENGTH = 80;

// ==============================================================================
// USER ACTIVITY TITLE
// ==============================================================================

export type UserActivityAction = "uploaded" | "replaced" | "deleted" | "linked";

export function generateUserActivityTitle(
  action: UserActivityAction,
  resourceName: string,
): string {
  return truncateUnicode(`{{user_id}} ${action} ${resourceName}`, MAX_TITLE_LENGTH, "...");
}

// ==============================================================================
// HELPERS
// ==============================================================================

export function kebabToSentenceCase(str: string): string {
  return str
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}
