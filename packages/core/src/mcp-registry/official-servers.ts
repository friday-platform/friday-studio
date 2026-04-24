/**
 * Official registry entries — curated servers that we badge in the UI.
 *
 * `providerId` is set when a dedicated Link provider exists; credentials
 * route to the existing provider instead of creating a dynamic one.
 * `displayName` overrides the raw upstream canonical name in the UI.
 */
export const OFFICIAL_REGISTRY_ENTRIES: Record<
  string,
  {
    displayName: string;
    /** If set, credentials route to this existing Link provider */
    providerId?: string;
  }
> = {
  // Dedicated Link providers
  "app.linear/linear": { displayName: "Linear", providerId: "linear" },
  "com.atlassian/atlassian-mcp-server": { displayName: "Atlassian", providerId: "atlassian" },
  "com.notion/mcp": { displayName: "Notion", providerId: "notion" },
  "io.github.PostHog/mcp": { displayName: "PostHog", providerId: "posthog" },
  // Curated, no Link provider (manual credentials)
  "com.microsoft/azure": { displayName: "Azure" },
  "com.supabase/mcp": { displayName: "Supabase" },
  "io.github.Snowflake-Labs/mcp": { displayName: "Snowflake" },
  "com.stripe/mcp": { displayName: "Stripe" },
  "com.auth0/mcp": { displayName: "Auth0" },
};

/**
 * Check if a canonical name from the upstream registry is an official entry.
 */
export function isOfficialCanonicalName(name: string): boolean {
  return name in OFFICIAL_REGISTRY_ENTRIES;
}

/**
 * Get the official override for a canonical name.
 * Returns undefined if not official.
 */
export function getOfficialOverride(
  name: string,
): { displayName: string; providerId?: string } | undefined {
  return OFFICIAL_REGISTRY_ENTRIES[name];
}
