/**
 * Curated annotation overlay for registry entries, keyed by canonical name.
 *
 * A code-shipped editorial artifact — one bundled, version-controlled table,
 * not a service. The existence of an annotation is a statement that the
 * curators think this server warrants a special hand.
 *
 * Fields split by when they apply:
 * - `displayName` / `providerId` — applied at install (write-time): the UI
 *   label override, and routing credentials to an existing Link provider
 *   instead of creating a dynamic one.
 * - `isOfficial` — drives the official badge in the UI.
 * - `staticNotes` / `doctorNotes` — read at point-of-use (read-time):
 *   curator markdown shown above the README, and curator hints woven into
 *   the doctor's LLM prompt. Never persisted on the entry.
 *
 * @module
 */

export interface RegistryAnnotation {
  /** UI label override; falls back to the canonical name. */
  displayName?: string;
  /** Routes credentials to an existing Link provider instead of a dynamic one. */
  providerId?: string;
  /** "We endorse this entry." Drives the official badge in the UI. Defaults to false. */
  isOfficial?: boolean;
  /** Curator-authored markdown rendered in the detail panel, above the README. */
  staticNotes?: string;
  /** Curator-authored hints woven into the doctor's LLM prompt as authoritative context. */
  doctorNotes?: string;
}

export const REGISTRY_ANNOTATIONS: Record<string, RegistryAnnotation> = {
  // Dedicated Link providers
  "app.linear/linear": { displayName: "Linear", providerId: "linear", isOfficial: true },
  "com.atlassian/atlassian-mcp-server": {
    displayName: "Atlassian",
    providerId: "atlassian",
    isOfficial: true,
  },
  "com.notion/mcp": { displayName: "Notion", providerId: "notion", isOfficial: true },
  "io.github.PostHog/mcp": { displayName: "PostHog", providerId: "posthog", isOfficial: true },
  // Curated, no Link provider (manual credentials)
  "com.microsoft/azure": { displayName: "Azure", isOfficial: true },
  "com.supabase/mcp": { displayName: "Supabase", isOfficial: true },
  "io.github.Snowflake-Labs/mcp": { displayName: "Snowflake", isOfficial: true },
  "com.stripe/mcp": { displayName: "Stripe", isOfficial: true },
  "com.auth0/mcp": { displayName: "Auth0", isOfficial: true },
};

/**
 * Get the curated annotation for a canonical name. Returns undefined when the
 * name is not in the overlay. Consumers read the whole annotation and pick the
 * fields they need.
 */
export function getAnnotation(name: string): RegistryAnnotation | undefined {
  return REGISTRY_ANNOTATIONS[name];
}

/**
 * Whether a canonical name is an endorsed ("official") entry. An annotation can
 * exist (notes, display name) without being official — `isOfficial` is opt-in.
 */
export function isOfficialCanonicalName(name: string): boolean {
  return getAnnotation(name)?.isOfficial ?? false;
}
