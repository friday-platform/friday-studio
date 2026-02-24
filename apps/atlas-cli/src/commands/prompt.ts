import process from "node:process";
import type { AtlasUIMessage, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { readUIMessageStream, type UIMessageChunk } from "ai";
import { nanoid } from "nanoid";
import type { YargsInstance } from "../utils/yargs.ts";

export const command = "prompt <message>";
export const desc = "Send prompt to Atlas conversation agent";
export const aliases = ["p"];

interface PromptArgs {
  message: string;
  chat?: string;
  human: boolean;
}

export function builder(y: YargsInstance) {
  return y
    .positional("message", { type: "string", demandOption: true })
    .option("chat", { type: "string", describe: "Continue existing chat by ID" })
    .option("human", { type: "boolean", default: false, describe: "Human-readable output" });
}

// Module-level state for tracking stream events
let toolsCalled = new Set<string>();
let streamError: string | undefined;
let atlasDataEvents: AtlasUIMessageChunk[] = [];

/**
 * Convert SSE byte stream to UIMessageChunk stream.
 * Filters out Atlas data events (type starts with "data-") which aren't UI message chunks.
 */
function createSSEToChunkTransform(): TransformStream<Uint8Array, UIMessageChunk> {
  let buffer = "";
  const decoder = new TextDecoder();

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            controller.terminate();
            return;
          }
          try {
            const parsed = JSON.parse(data) as AtlasUIMessageChunk;

            // Filter out Atlas data events - they're not UI message chunks
            if (parsed.type?.startsWith("data-")) {
              atlasDataEvents.push(parsed);
            } else {
              // Track state for summary
              if (parsed.type === "tool-input-available") {
                toolsCalled.add(parsed.toolName);
              }
              if (parsed.type === "error") {
                streamError = parsed.errorText;
              }
              controller.enqueue(parsed);
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    },
  });
}

/**
 * Handle UI messages from readUIMessageStream.
 */
function handleMessage(message: AtlasUIMessage, human: boolean): void {
  if (!human) {
    // JSON mode: output essential fields only (metadata contains verbose request data)
    const cleaned = {
      id: message.id,
      role: message.role,
      parts: message.parts.map((part) => {
        if (part.type === "reasoning") {
          const { providerMetadata: _providerMetadata, ...rest } = part;
          return rest;
        }
        return part;
      }),
    };
    console.log(JSON.stringify(cleaned));
    return;
  }

  // Human mode: output text parts
  for (const part of message.parts) {
    if (part.type === "text") {
      process.stdout.write(part.text);
    }
  }
}

export const handler = async (argv: PromptArgs): Promise<void> => {
  // Reset state at start of handler
  toolsCalled = new Set<string>();
  streamError = undefined;
  atlasDataEvents = [];

  const chatId = argv.chat ?? nanoid();
  const messageId = nanoid(8);
  const daemonUrl = getAtlasDaemonUrl();

  const body = {
    id: chatId,
    message: { id: messageId, role: "user", parts: [{ type: "text", text: argv.message }] },
  };

  // Set up abort controller for Ctrl+C handling
  const abortController = new AbortController();
  const handleAbort = () => {
    abortController.abort();
    process.exit(130); // Standard exit code for SIGINT
  };
  Deno.addSignalListener("SIGINT", handleAbort);

  try {
    const response = await fetch(`${daemonUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    // Convert SSE stream to UIMessageChunk stream
    const chunkStream = response.body.pipeThrough(createSSEToChunkTransform());

    // Read aggregated messages - readUIMessageStream yields progressive snapshots,
    // so we only want the final state of each message
    let lastMessage: AtlasUIMessage | undefined;
    let lastMessageId: string | undefined;

    for await (const message of readUIMessageStream<AtlasUIMessage>({ stream: chunkStream })) {
      const msg = message;

      // If message ID changed, output the previous message (it's complete)
      if (lastMessageId && lastMessageId !== msg.id && lastMessage) {
        handleMessage(lastMessage, argv.human);
      }

      lastMessage = msg;
      lastMessageId = msg.id;
    }

    // Output the final message
    if (lastMessage) {
      handleMessage(lastMessage, argv.human);
    }

    // Print summary output after SSE loop
    if (argv.human) {
      console.log(`\n\nChat ID: ${chatId}`);
      if (toolsCalled.size > 0) {
        console.log(`Tools called: ${Array.from(toolsCalled).join(", ")}`);
      }
    } else {
      // JSON mode: emit summary as final JSON line
      console.log(
        JSON.stringify({
          type: "cli-summary",
          chatId,
          toolsCalled: Array.from(toolsCalled),
          error: streamError ?? null,
          continuation: {
            canContinue: !streamError,
            command: `atlas prompt --chat ${chatId} "your follow-up"`,
          },
        }),
      );
    }
    if (streamError) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error("\nAborted by user");
      process.exit(130);
    }
    throw error;
  } finally {
    Deno.removeSignalListener("SIGINT", handleAbort);
  }
};
