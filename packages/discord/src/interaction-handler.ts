/**
 * Processes Discord interactions from HTTP webhook endpoint.
 */

import { logger } from "@atlas/logger";
import type { WorkspaceManager } from "@atlas/workspace";
import type {
  APIActionRowComponent,
  APIButtonComponent,
  APIInteraction,
  APIInteractionResponse,
  APIUser,
  RESTPostAPICurrentUserCreateDMChannelResult,
} from "@discordjs/core";
import {
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  Routes,
} from "@discordjs/core";
import type { REST } from "@discordjs/rest";
import { verifyKey } from "discord-interactions";
import type { Context } from "hono";
import { runDiscordConversation } from "./conversation.ts";
import { DiscordCommandError, DiscordInternalError } from "./errors.ts";
import type { DaemonSignalTrigger } from "./integration.ts";
import type { DiscordSignalRegistrar } from "./registrar.ts";
import {
  type ChatCommandOptions,
  ChatCommandOptionsSchema,
  type DiscordSignalMetadata,
  DiscordSignalMetadataSchema,
  type ParsedInteraction,
} from "./schemas.ts";
import {
  createAuthenticatedRestClient,
  generateDiscordChatId,
  sendDiscordMessage,
  updateDiscordInteraction,
} from "./utils.ts";

/**
 * Handles Discord HTTP interactions: signature verification, command routing, and conversation responses.
 */
export class DiscordInteractionHandler {
  private readonly rest: REST;

  constructor(
    private readonly signalRegistrar: DiscordSignalRegistrar,
    private readonly workspaceManager: WorkspaceManager,
    private readonly applicationId: string,
    private readonly publicKey: string,
    private readonly botToken: string,
    private readonly daemon: DaemonSignalTrigger,
  ) {
    this.rest = createAuthenticatedRestClient(botToken);
  }

  /**
   * Handle incoming Discord interaction from HTTP endpoint
   *
   * This is the main entry point called by the HTTP route handler.
   *
   * @param c - Hono context
   * @returns HTTP response to send back to Discord
   */
  async handleInteraction(c: Context): Promise<Response> {
    try {
      // Step 1: Verify Discord signature (security critical)
      const isValid = await this.verifySignature(c.req.raw.clone());
      if (!isValid) {
        logger.warn("Invalid Discord signature", {
          headers: Object.fromEntries(c.req.raw.headers.entries()),
        });
        return c.text("Invalid signature", 401);
      }

      // Step 2: Parse interaction payload
      //
      // Type annotation (not assertion): After Ed25519 signature verification,
      // we cryptographically know this came from Discord and matches APIInteraction.
      // The signature is stronger proof than any schema validation.
      const interaction: APIInteraction = await c.req.json();

      // Step 3: Handle PING (Discord verification)
      if (interaction.type === InteractionType.Ping) {
        return this.respondToPing(c);
      }

      // Step 4: Handle APPLICATION_COMMAND
      if (interaction.type === InteractionType.ApplicationCommand) {
        return await this.handleCommand(c, interaction);
      }

      // Step 5: Handle MESSAGE_COMPONENT (button clicks)
      if (interaction.type === InteractionType.MessageComponent) {
        return await this.handleButtonClick(c, interaction);
      }

      // Unknown interaction type
      logger.warn("Unknown Discord interaction type", {
        type: interaction.type,
        id: interaction.id,
      });
      return c.text("Unknown interaction type", 400);
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * Verify Discord ed25519 signature
   *
   * Discord signs all requests with ed25519. We must verify the signature
   * to prevent unauthorized requests.
   *
   * Uses discord-interactions library for signature verification.
   *
   * @see https://discord.com/developers/docs/interactions/receiving-and-responding#security-and-authorization
   */
  private async verifySignature(request: Request): Promise<boolean> {
    try {
      const signature = request.headers.get("X-Signature-Ed25519");
      const timestamp = request.headers.get("X-Signature-Timestamp");
      const body = await request.text();

      if (!signature || !timestamp) {
        logger.debug("Missing Discord signature headers");
        return false;
      }

      // Use discord-interactions library for verification
      return verifyKey(body, signature, timestamp, this.publicKey);
    } catch (error) {
      logger.error("Failed to verify Discord signature", { error });
      return false;
    }
  }

  /**
   * Respond to Discord PING (verification)
   */
  private respondToPing(c: Context): Response {
    const response: APIInteractionResponse = { type: InteractionResponseType.Pong };
    return c.json(response);
  }

  /**
   * Handle APPLICATION_COMMAND interaction
   */
  private async handleCommand(c: Context, interaction: APIInteraction): Promise<Response> {
    try {
      const parsed = this.parseInteraction(interaction);

      switch (parsed.subcommand) {
        case "ping":
          return this.handlePing(c, parsed);

        case "workspaces":
          return await this.handleWorkspaces(c, parsed);

        case "chat":
          return await this.handleChat(c, parsed);

        default:
          throw new DiscordCommandError(`Unknown subcommand: ${parsed.subcommand}`);
      }
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * Extract user from interaction
   *
   * Handles both guild (member.user) and DM (user) interactions
   */
  private extractUser(interaction: APIInteraction): APIUser {
    if ("member" in interaction && interaction.member?.user) {
      return interaction.member.user;
    }
    if ("user" in interaction && interaction.user) {
      return interaction.user;
    }
    throw new DiscordInternalError("Interaction missing user");
  }

  /**
   * Parse Discord interaction into our internal format
   * Only call for APPLICATION_COMMAND interactions (not button clicks)
   */
  private parseInteraction(interaction: APIInteraction): ParsedInteraction {
    const data = interaction.data;
    if (!data) {
      throw new DiscordInternalError("Interaction missing data");
    }

    // For APPLICATION_COMMAND, name is required
    if (!("name" in data)) {
      throw new DiscordInternalError("Command interaction missing name");
    }

    const user = this.extractUser(interaction);

    const subcommandOption = "options" in data ? data.options?.[0] : undefined;
    const subcommand = subcommandOption?.name || "";

    // Convert options array to record
    const options: Record<string, string | number | boolean> = {};
    if (subcommandOption && "options" in subcommandOption && subcommandOption.options) {
      for (const opt of subcommandOption.options) {
        if ("value" in opt && opt.value !== undefined) {
          options[opt.name] = opt.value;
        }
      }
    }

    return {
      id: interaction.id,
      token: interaction.token,
      guildId: ("guild_id" in interaction && interaction.guild_id) || null,
      channelId:
        ("channel" in interaction && interaction.channel?.id) ||
        ("channel_id" in interaction && interaction.channel_id) ||
        "",
      user,
      command: data.name,
      subcommand,
      options,
    };
  }

  /**
   * Handle /atlas ping command
   */
  private handlePing(c: Context, _parsed: ParsedInteraction): Response {
    const workspaceCount = this.signalRegistrar.getWorkspaceCount();
    const signalCount = this.signalRegistrar.getTotalSignalCount();

    const response: APIInteractionResponse = {
      type: InteractionResponseType.ChannelMessageWithSource,
      data: {
        content:
          `✅ **Atlas daemon online**\n` +
          `• Workspaces: ${workspaceCount}\n` +
          `• Discord signals: ${signalCount}`,
        flags: MessageFlags.Ephemeral,
      },
    };

    return c.json(response);
  }

  /**
   * Handle /atlas workspaces command
   * Shows all workspaces and highlights which have Discord signals
   */
  private async handleWorkspaces(c: Context, _parsed: ParsedInteraction): Promise<Response> {
    const allWorkspaces = await this.workspaceManager.list();

    if (allWorkspaces.length === 0) {
      const response: APIInteractionResponse = {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { content: "No workspaces registered.", flags: MessageFlags.Ephemeral },
      };

      return c.json(response);
    }

    // Format workspace list
    const lines = ["**Available Workspaces:**\n"];

    for (const workspace of allWorkspaces) {
      const discordSignals = this.signalRegistrar.getWorkspaceSignals(workspace.id);
      const hasDiscord = discordSignals.length > 0;

      if (hasDiscord) {
        lines.push(
          `**${workspace.name}** \`${workspace.id}\` 🎮 ${discordSignals.length} Discord signal${
            discordSignals.length !== 1 ? "s" : ""
          }`,
        );
      } else {
        lines.push(`**${workspace.name}** \`${workspace.id}\``);
      }
    }

    const response: APIInteractionResponse = {
      type: InteractionResponseType.ChannelMessageWithSource,
      data: { content: lines.join("\n"), flags: MessageFlags.Ephemeral },
    };

    return c.json(response);
  }

  /**
   * Handle /atlas chat command - conversation with response accumulation
   */
  private async handleChat(c: Context, parsed: ParsedInteraction): Promise<Response> {
    try {
      const options = ChatCommandOptionsSchema.parse(parsed.options);

      const streamId = await generateDiscordChatId(
        parsed.guildId,
        parsed.channelId,
        parsed.user.id,
      );

      const discordMetadata: DiscordSignalMetadata = DiscordSignalMetadataSchema.parse({
        guildId: parsed.guildId,
        channelId: parsed.channelId,
        userId: parsed.user.id,
        username: parsed.user.username,
        discriminator: parsed.user.discriminator,
        timestamp: new Date().toISOString(),
        interactionId: parsed.id,
        interactionToken: parsed.token,
      });

      const ackResponse: APIInteractionResponse = {
        type: InteractionResponseType.DeferredChannelMessageWithSource,
      };

      this.startConversationAsync(options, streamId, discordMetadata, parsed.token).catch(
        (error) => {
          logger.error("Failed to start conversation asynchronously", {
            message: options.message,
            streamId,
            error,
          });
        },
      );

      return c.json(ackResponse);
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * Handle MESSAGE_COMPONENT interaction (button click)
   */
  private async handleButtonClick(c: Context, interaction: APIInteraction): Promise<Response> {
    try {
      const customId =
        interaction.data && "custom_id" in interaction.data
          ? interaction.data.custom_id
          : undefined;

      if (customId === "continue_dm") {
        return await this.handleContinueDM(c, interaction);
      }

      throw new DiscordCommandError(`Unknown button: ${customId}`);
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * Handle "Continue in DM" button click
   * Opens DM channel and sends welcome message
   */
  private async handleContinueDM(c: Context, interaction: APIInteraction): Promise<Response> {
    try {
      const userId =
        ("user" in interaction && interaction.user?.id) ||
        ("member" in interaction && interaction.member?.user?.id);

      if (!userId) {
        throw new DiscordInternalError("No user ID in button interaction");
      }

      // Open DM channel with user
      const dmChannel = await this.openDMChannel(userId);

      await sendDiscordMessage(
        this.botToken,
        dmChannel.id,
        "👋 Hi! You can send me messages here and I'll respond naturally. No commands needed!",
      );

      // Update original message to confirm
      const response: APIInteractionResponse = {
        type: InteractionResponseType.UpdateMessage,
        data: {
          content: "✅ Check your DMs! I've sent you a message there.",
          components: [], // Remove button
        },
      };

      return c.json(response);
    } catch (error) {
      logger.error("Failed to handle Continue in DM button", { error });
      return this.handleError(c, error);
    }
  }

  /**
   * Open DM channel with user
   * @see https://discord.com/developers/docs/resources/user#create-dm
   */
  private async openDMChannel(userId: string): Promise<{ id: string }> {
    try {
      // Using library's Result type for this endpoint (cast required - REST returns unknown)
      const response = (await this.rest.post(Routes.userChannels(), {
        body: { recipient_id: userId },
      })) as RESTPostAPICurrentUserCreateDMChannelResult;

      return { id: response.id };
    } catch (error) {
      logger.error("Failed to open DM channel", { error, userId });
      throw error;
    }
  }

  /**
   * Start conversation asynchronously with response accumulation
   */
  private async startConversationAsync(
    options: ChatCommandOptions,
    streamId: string,
    discordMetadata: DiscordSignalMetadata,
    interactionToken: string,
  ): Promise<void> {
    logger.info("Starting Discord conversation", {
      message: options.message.slice(0, 100),
      chatId: streamId,
      userId: discordMetadata.userId,
    });

    const result = await runDiscordConversation(this.daemon, {
      message: options.message,
      userId: discordMetadata.userId,
      guildId: discordMetadata.guildId,
      channelId: discordMetadata.channelId,
      chatId: streamId,
      additionalPayload: { _discord: discordMetadata },
    });

    if (result.ok) {
      // Send accumulated response once
      await updateDiscordInteraction(
        this.applicationId,
        interactionToken,
        result.data.responseText || "_(No response)_",
      );

      // Add "Continue in DM" button
      const button = this.createContinueDMButton();
      await this.updateInteractionWithComponents(interactionToken, undefined, [button]);

      logger.info("Discord conversation completed", { chatId: result.data.chatId });
    } else {
      logger.error("Discord conversation failed", {
        chatId: result.error.chatId,
        error: result.error.error,
      });

      await updateDiscordInteraction(
        this.applicationId,
        interactionToken,
        `❌ Conversation failed: ${result.error.error}`,
      );
    }
  }

  /**
   * Create "Continue in DM" button
   *
   * Constructs button component directly to avoid version conflicts with builders library.
   */
  private createContinueDMButton(): APIActionRowComponent<APIButtonComponent> {
    return {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Primary,
          custom_id: "continue_dm",
          label: "Continue in DM",
        },
      ],
    };
  }

  /**
   * Update interaction with components (buttons)
   *
   * Uses @discordjs/rest to edit the original interaction response
   * @see https://discord.com/developers/docs/interactions/receiving-and-responding#edit-original-interaction-response
   */
  private async updateInteractionWithComponents(
    interactionToken: string,
    content: string | undefined,
    components: APIActionRowComponent<APIButtonComponent>[],
  ): Promise<void> {
    try {
      const body: { content?: string; components: APIActionRowComponent<APIButtonComponent>[] } = {
        components,
      };
      if (content !== undefined) {
        body.content = content;
      }

      // Use Routes.webhookMessage() with '@original' to edit the original interaction response
      await this.rest.patch(
        Routes.webhookMessage(this.applicationId, interactionToken, "@original"),
        { body },
      );
    } catch (error) {
      logger.error("Failed to update Discord interaction with components", { error });
    }
  }

  /**
   * Handle errors and return appropriate Discord response
   */
  private handleError(c: Context, error: unknown): Response {
    if (error instanceof DiscordCommandError) {
      // User-facing error - safe to show
      const response: APIInteractionResponse = {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { content: `❌ ${error.message}`, flags: MessageFlags.Ephemeral },
      };

      return c.json(response);
    }

    // Internal error - log but don't expose details
    logger.error("Discord interaction handler error", { error });

    const response: APIInteractionResponse = {
      type: InteractionResponseType.ChannelMessageWithSource,
      data: { content: "❌ An internal error occurred", flags: MessageFlags.Ephemeral },
    };

    return c.json(response);
  }
}
