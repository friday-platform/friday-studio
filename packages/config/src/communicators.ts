import { z } from "zod";
import {
  DiscordProviderConfigSchema,
  GitHubProviderConfigSchema,
  SlackProviderConfigSchema,
  TeamsProviderConfigSchema,
  TelegramProviderConfigSchema,
  WhatsAppProviderConfigSchema,
} from "./signals.ts";

/**
 * Canonical 6-kind enum for chat-transport communicators. Single source of
 * truth for all surfaces — config, daemon wiring, agent prompts.
 */
export const CommunicatorKindSchema = z.enum([
  "slack",
  "telegram",
  "discord",
  "teams",
  "whatsapp",
  "github",
]);
export type CommunicatorKind = z.infer<typeof CommunicatorKindSchema>;

/**
 * Communicator kind → Link provider id. Most kinds use the same string for
 * both; `github` is the outlier because Link's PAT-based `githubProvider`
 * already owns id `"github"`, so the App-based provider used by the
 * communicator is registered as `"github-app"` (see
 * `apps/link/src/providers/constants.ts`). Consumers that need to talk to
 * Link's `/providers/:id` or `/credentials` routes for a given communicator
 * kind MUST go through this map, not the kind string directly.
 */
export const COMMUNICATOR_KIND_TO_PROVIDER_ID: Record<CommunicatorKind, string> = {
  slack: "slack",
  telegram: "telegram",
  discord: "discord",
  teams: "teams",
  whatsapp: "whatsapp",
  github: "github-app",
};

/**
 * Top-level workspace.yml `communicators` map.
 *
 * Declares which chat platforms a workspace uses, decoupled from inbound
 * `signals`. The `kind` discriminator deliberately differs from signal's
 * `provider` discriminator: signals retain `provider` for backward
 * compatibility, while the new declaration site uses the new "communicator"
 * vocabulary.
 */
const SlackCommunicatorSchema = SlackProviderConfigSchema.extend({ kind: z.literal("slack") });

const TelegramCommunicatorSchema = TelegramProviderConfigSchema.extend({
  kind: z.literal("telegram"),
});

const DiscordCommunicatorSchema = DiscordProviderConfigSchema.extend({
  kind: z.literal("discord"),
});

const TeamsCommunicatorSchema = TeamsProviderConfigSchema.extend({ kind: z.literal("teams") });

const WhatsAppCommunicatorSchema = WhatsAppProviderConfigSchema.extend({
  kind: z.literal("whatsapp"),
});

const GitHubCommunicatorSchema = GitHubProviderConfigSchema.extend({ kind: z.literal("github") });

export const CommunicatorConfigSchema = z.discriminatedUnion("kind", [
  SlackCommunicatorSchema,
  TelegramCommunicatorSchema,
  DiscordCommunicatorSchema,
  TeamsCommunicatorSchema,
  WhatsAppCommunicatorSchema,
  GitHubCommunicatorSchema,
]);

export type CommunicatorConfig = z.infer<typeof CommunicatorConfigSchema>;
