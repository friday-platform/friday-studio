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
import { buildSegments, extractImages } from "./render.ts";
import type { ImageDisplay, Segment, ToolCallDisplay } from "./types.ts";

/**
 * Render the artifact reference block for a `display_artifact` tool call.
 * Emits a download link if the path map has an entry, or a placeholder when
 * the underlying blob couldn't be read at export time.
 */
function renderArtifactReference(
  summary: ArtifactSummary,
  artifactPathMap: Map<string, string>,
): string {
  const title = escapeHtml(summary.title);
  const path = artifactPathMap.get(summary.id);
  if (path) {
    return (
      `<div class="artifact-ref">` +
      `<span class="artifact-title">${title}</span>` +
      `<a class="artifact-download" href="${escapeHtml(path)}" download>Download</a>` +
      `</div>`
    );
  }
  return (
    `<div class="artifact-ref">` +
    `<span class="artifact-title">${title}</span>` +
    `<span class="artifact-unavailable">[artifact file unavailable]</span>` +
    `</div>`
  );
}

/**
 * Type predicate for the `display_artifact` tool's output payload — see
 * `packages/system/agents/workspace-chat/tools/display-artifact.ts`. Successful
 * outputs carry an `artifactId` string we can resolve against `listByChat`.
 */
function extractDisplayedArtifactId(call: ToolCallDisplay): string | null {
  if (call.toolName !== "display_artifact") return null;
  if (call.state !== "output-available") return null;
  if (!isRecord(call.output)) return null;
  if (call.output.success !== true) return null;
  const id = call.output.artifactId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

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
 * Render context threaded through the tree so artifact-aware tool calls can
 * resolve their references without globals. `artifactsById` is a lookup of
 * every artifact `listByChat` returned for this chat; `artifactPathMap` maps
 * artifact id → relative zip asset path. Artifacts that failed to read have
 * a metadata entry in `artifactsById` but no path entry, which the renderer
 * surfaces as an `[artifact file unavailable]` placeholder.
 */
interface RenderContext {
  artifactsById: Map<string, ArtifactSummary>;
  artifactPathMap: Map<string, string>;
  /** Mutated as artifacts get rendered inline so the trailing list skips them. */
  renderedArtifactIds: Set<string>;
}

/**
 * Render a single {@link ToolCallDisplay} as a `<div class="tool-call">`
 * containing its name, status, optional input/output/error `<pre>` blocks,
 * and any nested children as further `<details>` elements. When the call is
 * a successful `display_artifact`, an artifact reference block is appended.
 */
function renderToolCall(call: ToolCallDisplay, ctx: RenderContext): string {
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

  const displayedId = extractDisplayedArtifactId(call);
  if (displayedId) {
    const summary = ctx.artifactsById.get(displayedId);
    if (summary) {
      ctx.renderedArtifactIds.add(displayedId);
      parts.push(renderArtifactReference(summary, ctx.artifactPathMap));
    }
  }

  if (call.children && call.children.length > 0) {
    parts.push(`<div class="tool-call-children">`);
    for (const child of call.children) {
      parts.push(renderChildBurstDetails(child, ctx));
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
function renderChildBurstDetails(call: ToolCallDisplay, ctx: RenderContext): string {
  const summary =
    `${escapeHtml(statusIcon(call.state))} ${escapeHtml(call.toolName)}`;
  return (
    `<details class="tool-burst tool-burst-nested">` +
    `<summary>${summary}</summary>` +
    renderToolCall(call, ctx) +
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
  ctx: RenderContext,
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
    body.push(renderToolCall(call, ctx));
  }

  return (
    `<details class="tool-burst">` +
    `<summary>${summaryText}</summary>` +
    body.join("") +
    `</details>`
  );
}

/**
 * Render an inline image as an `<img>` tag. The `url` is expected to be a
 * data URL (e.g. `data:image/png;base64,...`); base64 stays inline — no
 * extraction to disk. T16 will handle external artifact bundling.
 */
function renderImage(img: ImageDisplay): string {
  const alt = img.filename ?? "attached image";
  return `<img src="${escapeHtml(img.url)}" alt="${escapeHtml(alt)}" class="message-image">`;
}

/**
 * Render a system-role message as a centered chip-style bubble. System
 * messages carry workspace context / onboarding prompts and don't have
 * tool bursts or images in practice, so we walk text segments only.
 * Styling lands in T17; this just emits the `<div class="system-content">`
 * element so the styling has a hook.
 */
function renderSystemMessage(msg: AtlasUIMessage): string {
  const segments: Segment[] = buildSegments(msg);
  let text = "";
  for (const segment of segments) {
    if (segment.type === "text") text += segment.content;
  }
  if (text.length === 0) return "";
  return `<div class="system-content">${markdownToHTML(text)}</div>`;
}

/**
 * Render one assistant/user/system/tool message by walking its segments in
 * document order. Text segments go through `markdownToHTML` (same path the
 * live chat UI uses) so code blocks, links, lists, and inline formatting
 * survive the export. `markdownToHTML` produces already-safe HTML — do not
 * `escapeHtml` its output or you'll double-escape `<p>` into `&lt;p&gt;`.
 *
 * System messages are routed to a distinct chip-style element via
 * {@link renderSystemMessage}. For all other roles, any inline images
 * (data-URL `file` parts) render after the segment body — matching the
 * live chat UI's `message-images` block.
 */
function renderMessage(msg: AtlasUIMessage, ctx: RenderContext): string {
  if (msg.role === "system") return renderSystemMessage(msg);

  const segments: Segment[] = buildSegments(msg);
  const body: string[] = [];
  for (const segment of segments) {
    if (segment.type === "text") {
      if (segment.content.length > 0) {
        body.push(`<div class="content">${markdownToHTML(segment.content)}</div>`);
      }
      continue;
    }
    body.push(renderToolBurstSegment(segment.calls, segment.reasoning, ctx));
  }

  const images = extractImages(msg);
  if (images.length > 0) {
    body.push(`<div class="message-images">${images.map(renderImage).join("")}</div>`);
  }

  return (
    `<div class="message" data-role="${escapeHtml(msg.role)}">` +
    `<div class="role">${escapeHtml(msg.role)}</div>` +
    body.join("") +
    `</div>`
  );
}

/**
 * Render the trailing "Artifacts" section listing every artifact returned by
 * `listByChat` that wasn't already attributed to a `display_artifact` call.
 * Failed reads (no entry in `artifactPathMap`) render as the unavailable
 * placeholder so the user can see the artifact existed even when its blob
 * couldn't be bundled.
 */
function renderArtifactList(ctx: RenderContext): string {
  const remaining: ArtifactSummary[] = [];
  for (const summary of ctx.artifactsById.values()) {
    if (!ctx.renderedArtifactIds.has(summary.id)) remaining.push(summary);
  }
  if (remaining.length === 0) return "";

  const items = remaining
    .map((summary) => `<li>${renderArtifactReference(summary, ctx.artifactPathMap)}</li>`)
    .join("");
  return (
    `<section class="artifacts">` +
    `<h2>Artifacts</h2>` +
    `<ul class="artifact-list">${items}</ul>` +
    `</section>`
  );
}

/**
 * Render a {@link Chat} to a complete HTML document string. `artifacts` is
 * the deduped result of `ArtifactStorage.listByChat({ chatId })`; entries
 * with no matching `artifactPathMap` value are rendered as
 * `[artifact file unavailable]` placeholders. Tool-call cards whose output
 * is a successful `display_artifact` consume their referenced artifact
 * inline; anything left over surfaces in a trailing list at the end of the
 * document.
 */
export function renderChatToHTML(
  chat: Chat,
  artifacts: ArtifactSummary[],
  artifactPathMap: Map<string, string>,
): string {
  const artifactsById = new Map<string, ArtifactSummary>();
  for (const summary of artifacts) {
    artifactsById.set(summary.id, summary);
  }
  const ctx: RenderContext = {
    artifactsById,
    artifactPathMap,
    renderedArtifactIds: new Set<string>(),
  };

  const titleId = chat.id.slice(0, 8);
  const messageHtml = chat.messages.map((msg) => renderMessage(msg, ctx)).join("\n");
  const artifactHtml = renderArtifactList(ctx);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Chat ${escapeHtml(titleId)}</title>
</head>
<body>
${messageHtml}
${artifactHtml}
</body>
</html>
`;
}
