import { z } from "zod";
import {
  DiscordProviderConfigSchema,
  SlackProviderConfigSchema,
  TeamsProviderConfigSchema,
  TelegramProviderConfigSchema,
  WhatsAppProviderConfigSchema,
} from "./signals.ts";

/**
 * Canonical 5-kind enum for chat-transport communicators. Single source of
 * truth for all surfaces — config, daemon wiring, agent prompts.
 */
export const CommunicatorKindSchema = z.enum(["slack", "telegram", "discord", "teams", "whatsapp"]);
export type CommunicatorKind = z.infer<typeof CommunicatorKindSchema>;

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

export const CommunicatorConfigSchema = z.discriminatedUnion("kind", [
  SlackCommunicatorSchema,
  TelegramCommunicatorSchema,
  DiscordCommunicatorSchema,
  TeamsCommunicatorSchema,
  WhatsAppCommunicatorSchema,
]);

export type CommunicatorConfig = z.infer<typeof CommunicatorConfigSchema>;
