/**
 * Registers global slash commands with Discord REST API on daemon startup.
 */

import { logger } from "@atlas/logger";
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type RESTPostAPIApplicationCommandsJSONBody,
  type RESTPutAPIApplicationCommandsResult,
  Routes,
} from "@discordjs/core";
import { DiscordInternalError } from "./errors.ts";
import { createAuthenticatedRestClient } from "./utils.ts";

/**
 * Build command definitions as JSON for Discord REST API
 */
function buildCommandDefinitions(): RESTPostAPIApplicationCommandsJSONBody[] {
  return [
    {
      name: "atlas",
      description: "Atlas daemon commands",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "ping",
          description: "Check daemon status",
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "workspaces",
          description: "List available workspaces",
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "chat",
          description: "Chat with Atlas conversation agent",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "message",
              description: "Your message to the agent",
              required: true,
            },
          ],
        },
      ],
    },
  ];
}

/**
 * Register global /atlas commands with Discord REST API.
 *
 * @param botToken - Discord bot token for authentication
 * @param applicationId - Discord application/client ID
 */
export async function registerCommands(botToken: string, applicationId: string): Promise<void> {
  const rest = createAuthenticatedRestClient(botToken);
  const commands = buildCommandDefinitions();

  try {
    // Register commands via Discord REST API
    // Using library's Result type for this endpoint (cast required - REST returns unknown)
    const response = (await rest.put(Routes.applicationCommands(applicationId), {
      body: commands,
    })) as RESTPutAPIApplicationCommandsResult;

    logger.info("Discord commands registered", {
      commands: commands.map((c) => c.name),
      count: response.length,
    });
  } catch (error) {
    logger.error("Failed to register Discord commands", { error });
    throw new DiscordInternalError("Failed to register Discord commands");
  }
}
