import GlobeIcon from "$lib/components/icons/globe.svelte";
import Anthropic from "$lib/components/icons/integrations/anthropic.svelte";
import AtlassianIcon from "$lib/components/icons/integrations/atlassian.svelte";
import GithubIcon from "$lib/components/icons/integrations/github.svelte";
import GoogleSheetsIcon from "$lib/components/icons/integrations/google-sheets.svelte";
import LinearIcon from "$lib/components/icons/integrations/linear.svelte";
import NotionIcon from "$lib/components/icons/integrations/notion.svelte";
import PosthogIcon from "$lib/components/icons/integrations/posthog.svelte";
import SentryIcon from "$lib/components/icons/integrations/sentry.svelte";
import SlackIcon from "$lib/components/icons/integrations/slack-color.svelte";

type SvelteIcon = typeof GlobeIcon;

/** Maps provider string identifiers to their Svelte icon components. */
const providerIcons: Record<string, SvelteIcon> = {
  anthropic: Anthropic,
  github: GithubIcon,
  "google-sheets": GoogleSheetsIcon,
  airtable: GlobeIcon,
  slack: SlackIcon,
  notion: NotionIcon,
  linear: LinearIcon,
  atlassian: AtlassianIcon,
  jira: AtlassianIcon,
  sentry: SentryIcon,
  posthog: PosthogIcon,
};

/** Domain-to-provider mapping for URL detection. */
const domainProviders: Array<{ match: (host: string) => boolean; provider: string }> = [
  { match: (h) => h === "notion.so" || h.endsWith(".notion.so"), provider: "notion" },
  { match: (h) => h === "docs.google.com", provider: "google-sheets" },
  { match: (h) => h === "github.com", provider: "github" },
  { match: (h) => h === "linear.app", provider: "linear" },
  { match: (h) => h.endsWith(".atlassian.net"), provider: "atlassian" },
  { match: (h) => h === "sentry.io" || h.endsWith(".sentry.io"), provider: "sentry" },
  { match: (h) => h === "slack.com" || h.endsWith(".slack.com"), provider: "slack" },
];

/**
 * Detects the provider and icon for a given URL.
 * Falls back to `{ provider: "url", icon: GlobeIcon }` for unrecognized domains.
 */
export function detectProvider(url: string): { provider: string; icon: SvelteIcon } {
  try {
    const { hostname } = new URL(url);
    const host = hostname.toLowerCase();
    for (const entry of domainProviders) {
      if (entry.match(host)) {
        return { provider: entry.provider, icon: providerIcons[entry.provider] ?? GlobeIcon };
      }
    }
  } catch {
    // invalid URL — fall through to default
  }
  return { provider: "url", icon: GlobeIcon };
}

/**
 * Returns the icon component for a known provider string.
 * Falls back to GlobeIcon for unrecognized providers.
 */
export function getProviderIcon(provider: string): SvelteIcon {
  return providerIcons[provider.toLowerCase()] ?? GlobeIcon;
}

/**
 * Extracts a human-readable name from a URL.
 * Takes the last meaningful path segment, decodes URI components,
 * strips IDs/hashes, and title-cases the result.
 * Returns the domain name if the path is empty.
 */
export function extractNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);

    // Walk backwards to find a meaningful segment (skip pure IDs/hashes)
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i];
      if (!segment) continue;
      const decoded = decodeURIComponent(segment);
      // Skip segments that look like IDs (hex strings, UUIDs, numeric)
      if (/^[0-9a-f-]{8,}$/i.test(decoded) || /^\d+$/.test(decoded)) continue;
      return titleCase(decoded);
    }

    // No meaningful path — use domain
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Converts a slug-like or dash/underscore-separated string to Title Case. */
function titleCase(str: string): string {
  return str
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
