import Anthropic from "$lib/components/icons/integrations/anthropic.svelte";
import Atlassian from "$lib/components/icons/integrations/atlassian.svelte";
import Github from "$lib/components/icons/integrations/github.svelte";
import Gmail from "$lib/components/icons/integrations/gmail.svelte";
import GoogleCalendar from "$lib/components/icons/integrations/google-calendar.svelte";
import GoogleDocs from "$lib/components/icons/integrations/google-docs.svelte";
import GoogleDrive from "$lib/components/icons/integrations/google-drive.svelte";
import GoogleSheets from "$lib/components/icons/integrations/google-sheets.svelte";
import Linear from "$lib/components/icons/integrations/linear.svelte";
import Notion from "$lib/components/icons/integrations/notion.svelte";
import Posthog from "$lib/components/icons/integrations/posthog.svelte";
import Sentry from "$lib/components/icons/integrations/sentry.svelte";
import SlackColor from "$lib/components/icons/integrations/slack-color.svelte";
import type { Component } from "svelte";

export type ServiceIcon = { type: "component"; src: Component } | { type: "image"; src: string };

export type ServiceIconConfig = ServiceIcon & { background: string; backgroundDark: string };

const serviceIcons: Record<string, ServiceIconConfig> = {
  anthropic: {
    type: "component",
    src: Anthropic,
    background: "#F0EEE6",
    backgroundDark: "#1F1E1D",
  },
  "google-calendar": {
    type: "component",
    src: GoogleCalendar,
    background: "#EAF5FF",
    backgroundDark: "#1E2F40",
  },
  "google-gmail": {
    type: "component",
    src: Gmail,
    background: "#EAF5FF",
    backgroundDark: "#1E2F40",
  },
  "google-drive": {
    type: "component",
    src: GoogleDrive,
    background: "#EAF5FF",
    backgroundDark: "#1E2F40",
  },
  "google-sheets": {
    type: "component",
    src: GoogleSheets,
    background: "#EAF5FF",
    backgroundDark: "#1E2F40",
  },
  "google-docs": {
    type: "component",
    src: GoogleDocs,
    background: "#EAF5FF",
    backgroundDark: "#1E2F40",
  },
  slack: { type: "component", src: SlackColor, background: "#EEE9EF", backgroundDark: "#3C173E" },
  notion: { type: "component", src: Notion, background: "#E7E7E8", backgroundDark: "#2E2F33" },
  linear: { type: "component", src: Linear, background: "#EDEFFA", backgroundDark: "#222538" },
  atlassian: {
    type: "component",
    src: Atlassian,
    background: "#E8F1FF",
    backgroundDark: "#1A2436",
  },
  github: { type: "component", src: Github, background: "#F0F0F0", backgroundDark: "#21262D" },
  sentry: { type: "component", src: Sentry, background: "#EEEEF2", backgroundDark: "#242135" },
  posthog: { type: "component", src: Posthog, background: "#FDF5E5", backgroundDark: "#362C1B" },
};

export function getServiceIcon(provider: string): ServiceIconConfig | undefined {
  return serviceIcons[provider];
}
