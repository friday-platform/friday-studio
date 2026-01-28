import Google from "$lib/assets/integrations/google.png";
import Anthropic from "$lib/components/icons/integrations/anthropic.svelte";
import Atlassian from "$lib/components/icons/integrations/atlassian.svelte";
import Github from "$lib/components/icons/integrations/github.svelte";
import Linear from "$lib/components/icons/integrations/linear.svelte";
import Notion from "$lib/components/icons/integrations/notion.svelte";
import Posthog from "$lib/components/icons/integrations/posthog.svelte";
import Sentry from "$lib/components/icons/integrations/sentry.svelte";
import SlackColor from "$lib/components/icons/integrations/slack-color.svelte";
import type { Component } from "svelte";

export type ServiceIcon = { type: "component"; src: Component } | { type: "image"; src: string };

export type ServiceIconConfig = ServiceIcon & { background: string; backgroundDark: string };

const googleServices = [
  "google-calendar",
  "google-gmail",
  "google-drive",
  "google-docs",
  "google-sheets",
];

const serviceIcons: Record<string, ServiceIconConfig> = {
  anthropic: {
    type: "component",
    src: Anthropic,
    background: "#F0EEE6",
    backgroundDark: "#1F1E1D",
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

// Add Google services with shared config
const googleConfig: ServiceIconConfig = {
  type: "image",
  src: Google,
  background: "#EAF5FF",
  backgroundDark: "#1E2F40",
};

for (const service of googleServices) {
  serviceIcons[service] = googleConfig;
}

export function getServiceIcon(provider: string): ServiceIconConfig | undefined {
  return serviceIcons[provider];
}
