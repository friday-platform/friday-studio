/**
 * Server-side renderer that turns a {@link Chat} into a self-contained HTML
 * transcript. Walks {@link buildSegments} output in document order, emitting
 * text segments inline and tool-call bursts as collapsible `<details>`
 * elements. Subsequent tasks (T14–T17) layer in markdown rendering, image
 * support, system message chips, and full styling.
 *
 * @module
 */

import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { markdownToHTML } from "@atlas/ui/markdown";
import type { ArtifactSummary } from "../../artifacts/model.ts";
import type { Chat } from "./../storage.ts";
import { buildSegments } from "./render.ts";
import type { Segment, ToolCallDisplay } from "./types.ts";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Severity ordering for picking the worst child status when summarizing a
 * multi-call burst. Higher number = more severe.
 */
const STATE_SEVERITY: Record<ToolCallDisplay["state"], number> = {
  "input-streaming": 1,
  "input-available": 1,
  "approval-requested": 1,
  "approval-responded": 1,
  "output-denied": 2,
  "output-error": 3,
  "output-available": 0,
};

/**
 * Pick the worst (highest-severity) state across a list of tool calls. Used
 * to choose a single status icon for a multi-call burst summary.
 */
function worstState(calls: readonly ToolCallDisplay[]): ToolCallDisplay["state"] {
  let worst: ToolCallDisplay["state"] = "output-available";
  for (const call of calls) {
    if (STATE_SEVERITY[call.state] > STATE_SEVERITY[worst]) {
      worst = call.state;
    }
  }
  return worst;
}

/**
 * Map a tool-call state to a single Unicode codepoint that renders without
 * needing any specific font. Errors and denials are visually distinct from
 * in-progress and completed states.
 */
function statusIcon(state: ToolCallDisplay["state"]): string {
  switch (state) {
    case "output-available":
      return "✓"; // ✓
    case "output-error":
      return "✕"; // ✕
    case "output-denied":
      return "⊘"; // ⊘
    default:
      return "⋯"; // ⋯
  }
}

/**
 * Type predicate that widens an unknown value to `Record<string, unknown>`
 * so we can probe optional fields without `any`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Stringify an arbitrary value for `<pre>` display. Uses `JSON.stringify` for
 * objects/arrays and falls back to `String(...)` when the value is not
 * JSON-serializable (e.g. circular refs). Strings are returned as-is so we
 * don't double-quote raw text outputs.
 */
function stringifyForPre(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Render a single {@link ToolCallDisplay} as a `<div class="tool-call">`
 * containing its name, status, optional input/output/error `<pre>` blocks,
 * and any nested children as further `<details>` elements.
 */
function renderToolCall(call: ToolCallDisplay): string {
  const parts: string[] = [];

  parts.push(`<div class="tool-call" data-state="${escapeHtml(call.state)}">`);
  parts.push(
    `<div class="tool-call-header"><span class="tool-call-name">${escapeHtml(call.toolName)}</span>` +
      `<span class="tool-call-state">${escapeHtml(statusIcon(call.state))} ${escapeHtml(call.state)}</span></div>`,
  );

  const hasInput =
    call.input !== undefined && !(isRecord(call.input) && Object.keys(call.input).length === 0);
  if (hasInput) {
    parts.push(
      `<pre class="tool-input">${escapeHtml(stringifyForPre(call.input))}</pre>`,
    );
  }

  if (call.output !== undefined) {
    parts.push(
      `<pre class="tool-output">${escapeHtml(stringifyForPre(call.output))}</pre>`,
    );
  }

  if (call.state === "output-error" && typeof call.errorText === "string") {
    parts.push(`<pre class="tool-error">${escapeHtml(call.errorText)}</pre>`);
  }

  if (call.children && call.children.length > 0) {
    parts.push(`<div class="tool-call-children">`);
    for (const child of call.children) {
      parts.push(renderChildBurstDetails(child));
    }
    parts.push(`</div>`);
  }

  parts.push(`</div>`);
  return parts.join("");
}

/**
 * Render a nested child tool call as its own collapsible `<details>` so
 * delegate trees don't dump every descendant into the outer burst body.
 */
function renderChildBurstDetails(call: ToolCallDisplay): string {
  const summary =
    `${escapeHtml(statusIcon(call.state))} ${escapeHtml(call.toolName)}`;
  return (
    `<details class="tool-burst tool-burst-nested">` +
    `<summary>${summary}</summary>` +
    renderToolCall(call) +
    `</details>`
  );
}

/**
 * Render a `tool-burst` segment: one `<details>` element per burst, closed
 * by default, with a summary line that names the tool(s) and shows a status
 * icon for the worst final state. Body contains each call's input/output
 * panes, any reasoning text, and nested children.
 */
function renderToolBurstSegment(
  calls: readonly ToolCallDisplay[],
  reasoning: string | undefined,
): string {
  const first = calls[0];
  if (!first) return "";
  const state = worstState(calls);
  const icon = statusIcon(state);

  let summaryText: string;
  if (calls.length === 1) {
    summaryText = `${icon} ${escapeHtml(first.toolName)}`;
  } else {
    const allSameName = calls.every((c) => c.toolName === first.toolName);
    summaryText = allSameName
      ? `${icon} ${escapeHtml(first.toolName)} × ${calls.length}`
      : `${icon} ${calls.length} tool calls`;
  }

  const body: string[] = [];
  if (typeof reasoning === "string" && reasoning.length > 0) {
    body.push(`<div class="reasoning">${escapeHtml(reasoning)}</div>`);
  }
  for (const call of calls) {
    body.push(renderToolCall(call));
  }

  return (
    `<details class="tool-burst">` +
    `<summary>${summaryText}</summary>` +
    body.join("") +
    `</details>`
  );
}

/**
 * Render one assistant/user/system/tool message by walking its segments in
 * document order. Text segments go through `markdownToHTML` (same path the
 * live chat UI uses) so code blocks, links, lists, and inline formatting
 * survive the export. `markdownToHTML` produces already-safe HTML — do not
 * `escapeHtml` its output or you'll double-escape `<p>` into `&lt;p&gt;`.
 */
function renderMessage(msg: AtlasUIMessage): string {
  const segments: Segment[] = buildSegments(msg);
  const body: string[] = [];
  for (const segment of segments) {
    if (segment.type === "text") {
      if (segment.content.length > 0) {
        body.push(`<div class="content">${markdownToHTML(segment.content)}</div>`);
      }
      continue;
    }
    body.push(renderToolBurstSegment(segment.calls, segment.reasoning));
  }

  return (
    `<div class="message" data-role="${escapeHtml(msg.role)}">` +
    `<div class="role">${escapeHtml(msg.role)}</div>` +
    body.join("") +
    `</div>`
  );
}

/**
 * Render a {@link Chat} to a complete HTML document string. The second
 * `_artifacts` parameter is reserved for T16 (artifact bundling); the
 * tracer-bullet renderer ignores it but the signature is stable so callers
 * don't have to change when artifact rendering lands.
 */
export function renderChatToHTML(chat: Chat, _artifacts: ArtifactSummary[]): string {
  const titleId = chat.id.slice(0, 8);
  const messageHtml = chat.messages.map(renderMessage).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Chat ${escapeHtml(titleId)}</title>
</head>
<body>
${messageHtml}
</body>
</html>
`;
}
