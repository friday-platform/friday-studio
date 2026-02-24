import process from "node:process";
import type { AtlasUIMessage, AtlasUIMessagePart } from "@atlas/agent-sdk";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import type { YargsInstance } from "../utils/yargs.ts";

export const command = "chat [id]";
export const desc = "View chat transcripts";
export const aliases = ["ch"];

interface ChatArgs {
  id?: string;
  human: boolean;
  limit: number;
  showPrompts: boolean;
}

export function builder(y: YargsInstance) {
  return y
    .positional("id", { type: "string", describe: "Chat ID to view" })
    .option("human", { type: "boolean", default: false, describe: "Human-readable output" })
    .option("limit", { type: "number", default: 25, describe: "Max chats to list (1-100)" })
    .option("show-prompts", { type: "boolean", default: false, describe: "Show system prompt" });
}

/**
 * Clean message for JSON output - strip providerMetadata from reasoning parts.
 */
function cleanMessage(msg: AtlasUIMessage) {
  return {
    id: msg.id,
    role: msg.role,
    parts: msg.parts?.map((part) => {
      if (part.type === "reasoning") {
        const { providerMetadata: _providerMetadata, ...rest } = part;
        return rest;
      }
      return part;
    }),
  };
}

/**
 * Format message part for human-readable output.
 */
function formatPart(part: AtlasUIMessagePart): string {
  if (part.type === "text") return part.text;
  if (part.type === "reasoning") return `[thinking] ${part.text}`;
  if (part.type.startsWith("tool-")) return `[tool: ${part.type.slice(5)}]`;
  if (part.type === "dynamic-tool") return `[tool: ${part.toolName}]`;
  if (part.type.startsWith("data-")) return `[${part.type}]`;
  return `[${part.type}]`;
}

/**
 * Format relative time from ISO timestamp.
 */
function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Handle list chats command (no ID provided).
 */
async function handleListChats(human: boolean, limit: number): Promise<void> {
  const daemonUrl = getAtlasDaemonUrl();
  const response = await fetch(`${daemonUrl}/api/chat?limit=${limit}`);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const { chats, hasMore } = (await response.json()) as {
    chats: Array<{
      id: string;
      title?: string;
      createdAt: string;
      updatedAt: string;
      userId: string;
      workspaceId: string;
      source: string;
    }>;
    hasMore: boolean;
    nextCursor: number | null;
  };

  if (!human) {
    // JSON lines
    for (const chat of chats) {
      console.log(JSON.stringify(chat));
    }
  } else {
    console.log("Recent chats:\n");
    console.log("ID                     Title                Updated");
    console.log("─".repeat(60));
    for (const chat of chats) {
      const title = (chat.title ?? "Untitled").slice(0, 20).padEnd(20);
      const updated = formatRelativeTime(chat.updatedAt);
      console.log(`${chat.id.padEnd(22)} ${title} ${updated}`);
    }
    if (hasMore) {
      console.log("\n(more chats available)");
    }
  }

  process.exit(0);
}

export const handler = async (argv: ChatArgs): Promise<void> => {
  // If no ID, delegate to list
  if (!argv.id) {
    return handleListChats(argv.human, argv.limit);
  }

  const daemonUrl = getAtlasDaemonUrl();
  const response = await fetch(`${daemonUrl}/api/chat/${argv.id}`);

  if (!response.ok) {
    if (response.status === 404) {
      console.error(`Chat not found: ${argv.id}`);
      process.exit(1);
    }
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const { chat, messages, systemPromptContext } = (await response.json()) as {
    chat: { id: string; title?: string; createdAt: string; updatedAt: string };
    messages: AtlasUIMessage[];
    systemPromptContext: { timestamp: string; systemMessages: string[] } | null;
  };

  if (!argv.human) {
    // JSON mode: --show-prompts outputs context only
    if (argv.showPrompts) {
      if (systemPromptContext) {
        console.log(JSON.stringify(systemPromptContext));
        process.exit(0);
      } else {
        console.error("No system prompt context (chat predates feature)");
        process.exit(1);
      }
    }
    // Default: output messages
    for (const msg of messages) {
      console.log(JSON.stringify(cleanMessage(msg)));
    }
  } else {
    // Human mode
    console.log(`Chat: ${chat.id}`);
    console.log(`Title: ${chat.title ?? "Untitled"}`);

    if (argv.showPrompts) {
      if (!systemPromptContext) {
        console.log("\n[No system prompt context - chat predates feature]\n");
      } else {
        console.log(`\n=== SYSTEM PROMPT (${systemPromptContext.timestamp}) ===\n`);
        systemPromptContext.systemMessages.forEach((msg, i) => {
          console.log(`--- Message ${i + 1} ---\n`);
          console.log(msg);
          console.log();
        });
        console.log("=== END ===\n");
      }
    }

    console.log();
    for (const msg of messages) {
      console.log(`[${msg.role}]`);
      for (const part of msg.parts ?? []) {
        console.log(formatPart(part));
      }
      console.log();
    }
  }

  process.exit(0);
};
