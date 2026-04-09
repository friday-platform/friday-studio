/**
 * Language model middleware that converts the message body argument of
 * slack-mcp-server's `conversations_add_message` tool call from standard
 * markdown to Slack mrkdwn using the chat SDK's SlackFormatConverter.
 *
 * Why this exists: slack-mcp-server's built-in markdown converter
 * (github.com/takara2314/slack-go-util) is missing GFM extensions —
 * no strikethrough, no tables, and headings collapse to plain_text
 * blocks that drop inline formatting. The chat SDK's converter handles
 * all of those, so we intercept the tool call and feed the MCP server
 * pre-converted mrkdwn with `content_type: "text/plain"` to prevent
 * double-conversion.
 *
 * Applied only to the executor model in the slack communicator agent;
 * the planner and translator phases don't post, so they stay unwrapped.
 */
import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createLogger } from "@atlas/logger";
import { SlackFormatConverter } from "@chat-adapter/slack";
import { parseMarkdown } from "chat";
import { z } from "zod";

const logger = createLogger({ component: "slack-format-middleware" });
const converter = new SlackFormatConverter();

/**
 * slack-mcp-server exposes exactly one post-message tool.
 *
 * Upstream korotovsky/slack-mcp-server v1.2.2+ uses `text` as the canonical
 * body parameter (renamed from `payload` in PR #194) and keeps `payload` as
 * a backward-compat fallback. The tempestteam fork still uses `payload`.
 * We handle both so the middleware works regardless of which server is
 * spawned — whichever key the LLM emits, we convert it in place.
 */
const POST_TOOL_NAME = "conversations_add_message";

/**
 * Loose object — preserves channel_id / thread_ts / other params on
 * re-serialization. Both `text` and `payload` are optional because only
 * one is present depending on the MCP server version.
 */
const PostArgsSchema = z.looseObject({
  text: z.string().optional(),
  payload: z.string().optional(),
  content_type: z.enum(["text/markdown", "text/plain"]).optional(),
});

/**
 * Parse the tool call's stringified input, convert the body markdown
 * (`text` for upstream, `payload` for the fork) to Slack mrkdwn, force
 * `content_type` to `text/plain` so the MCP server doesn't re-interpret
 * the mrkdwn through its own (inferior) converter.
 *
 * Fails open: on any error (bad JSON, shape mismatch, parseMarkdown
 * throw) returns the original input unchanged.
 *
 * Exported for direct testing; the middleware below just wires it
 * into the tool-call stream and generate-result content paths.
 */
export function transformInput(rawInput: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(rawInput);
  } catch {
    return rawInput;
  }

  const result = PostArgsSchema.safeParse(raw);
  if (!result.success) return rawInput;

  const data = result.data;

  // Prefer `text` (upstream canonical) but fall back to `payload` (fork).
  const bodyKey: "text" | "payload" | null = data.text ? "text" : data.payload ? "payload" : null;
  if (bodyKey === null) return rawInput;

  try {
    const original = data[bodyKey];
    if (typeof original !== "string" || original.length === 0) return rawInput;
    data[bodyKey] = converter.fromAst(parseMarkdown(original));
    data.content_type = "text/plain";
    logger.debug("slack_format_applied", { bodyKey });
    return JSON.stringify(data);
  } catch (err) {
    logger.warn("slack_format_failed_passthrough", { err: String(err) });
    return rawInput;
  }
}

export const slackFormatMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3" as const,

  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    return {
      ...result,
      content: result.content.map((part) =>
        part.type === "tool-call" && part.toolName === POST_TOOL_NAME
          ? { ...part, input: transformInput(part.input) }
          : part,
      ),
    };
  },

  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    const transform = new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
      transform(chunk, controller) {
        if (chunk.type === "tool-call" && chunk.toolName === POST_TOOL_NAME) {
          controller.enqueue({ ...chunk, input: transformInput(chunk.input) });
          return;
        }
        controller.enqueue(chunk);
      },
    });
    return { stream: stream.pipeThrough(transform), ...rest };
  },
};
