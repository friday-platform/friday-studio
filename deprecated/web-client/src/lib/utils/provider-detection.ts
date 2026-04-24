import GlobeIcon from "$lib/components/icons/globe.svelte";
import Anthropic from "$lib/components/icons/integrations/anthropic.svelte";
import AtlassianIcon from "$lib/components/icons/integrations/atlassian.svelte";
import GithubIcon from "$lib/components/icons/integrations/github.svelte";
import GmailIcon from "$lib/components/icons/integrations/gmail.svelte";
import GoogleCalendarIcon from "$lib/components/icons/integrations/google-calendar.svelte";
import GoogleDocsIcon from "$lib/components/icons/integrations/google-docs.svelte";
import GoogleDriveIcon from "$lib/components/icons/integrations/google-drive.svelte";
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
  "google-calendar": GoogleCalendarIcon,
  "google-docs": GoogleDocsIcon,
  "google-drive": GoogleDriveIcon,
  "google-gmail": GmailIcon,
  "google-sheets": GoogleSheetsIcon,
  airtable: GlobeIcon,
  "slack-user": SlackIcon,
  "slack-app": SlackIcon,
  notion: NotionIcon,
  linear: LinearIcon,
  atlassian: AtlassianIcon,
  jira: AtlassianIcon,
  sentry: SentryIcon,
  posthog: PosthogIcon,
};

/**
 * Returns the icon component for a known provider string.
 * Falls back to GlobeIcon for unrecognized providers.
 */
export function getProviderIcon(provider: string): SvelteIcon {
  return providerIcons[provider.toLowerCase()] ?? GlobeIcon;
}
