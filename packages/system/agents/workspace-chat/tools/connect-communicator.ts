import type { ToolProgress } from "@atlas/agent-sdk";
import { type CommunicatorKind, CommunicatorKindSchema } from "@atlas/config";
import { tool } from "ai";
import { z } from "zod";

const KIND_DISPLAY_NAMES: Record<CommunicatorKind, string> = {
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
  teams: "Microsoft Teams",
  whatsapp: "WhatsApp",
};

/**
 * Factory that creates the `connect_communicator` tool — opens a chat-side
 * form so the user can wire an external chat platform (Slack, Telegram,
 * Discord, Teams, WhatsApp) as a surface for the workspace conversation.
 *
 * Communicators are surfaces for the same conversation that happens in the
 * playground — not tools Friday calls. Returning `{ kind, progress }` halts
 * the agent (via `connectCommunicatorSucceeded`) so the playground UI can
 * render the credential form inline before the agent continues.
 */
export function createConnectCommunicatorTool() {
  return tool({
    description:
      "Wire an *inbound chat surface* — Slack, Telegram, Discord, Microsoft Teams, or WhatsApp — so the user can type to Friday from that client and Friday's replies arrive there. Use ONLY when the user wants to reach Friday from one of these five platforms. Do NOT use for OAuth, credentials, Gmail, email, SMS, calendars, file storage, or any service Friday calls on the user's behalf — those go through the service-connection flow (`connect_service` / `enable_mcp_server` / `delegate`).",
    inputSchema: z.object({
      kind: CommunicatorKindSchema.describe("Chat platform to wire as a communicator surface"),
    }),
    // deno-lint-ignore require-await
    execute: async ({
      kind,
    }): Promise<{ kind: CommunicatorKind; progress: ToolProgress } | { error: string }> => {
      return {
        kind,
        progress: { label: `Connecting ${KIND_DISPLAY_NAMES[kind]}`, status: "active" },
      };
    },
  });
}
