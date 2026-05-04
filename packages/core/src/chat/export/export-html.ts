/**
 * Server-side renderer that turns a {@link Chat} into a self-contained HTML
 * transcript. Walks {@link buildSegments} output in document order, emitting
 * text segments inline and tool-call bursts as collapsible `<details>`
 * elements. The output is a single HTML document with an inline `<style>`
 * block — no external CSS or font loads, so the file works offline once
 * unzipped alongside its `assets/` directory.
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
 * Inlined stylesheet for the exported HTML document. Mirrors the live chat UI
 * (see `tools/agent-playground/src/lib/components/chat/chat-message-list.svelte`
 * `<style>` block and `tool-call-card.svelte`) plus the design tokens from
 * `packages/ui/src/lib/tokens.css` that we actually consume here. Keep these
 * in rough visual sync with those files — exact pixel parity is not required,
 * but the exported transcript should read as a sibling of the live chat.
 *
 * Light/dark mode: `color-scheme: light dark` plus `light-dark()` per the
 * W3C CSS Color Adjust Module §2 — same approach the live UI uses, so the
 * OS preference flips both surfaces and accents automatically.
 */
const EXPORT_STYLES = `
:root {
  color-scheme: light dark;

  --size-1: 0.25rem;
  --size-1-5: 0.375rem;
  --size-2: 0.5rem;
  --size-2-5: 0.625rem;
  --size-3: 0.75rem;
  --size-4: 1rem;
  --size-6: 1.5rem;

  --radius-1: 0.25rem;
  --radius-2: 0.375rem;
  --radius-3: 0.625rem;

  --font-sans: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;

  --font-size-0: 0.6875rem;
  --font-size-1: 0.75rem;
  --font-size-2: 0.8125rem;
  --font-size-3: 0.875rem;

  --color-text: light-dark(hsl(230 32% 14%), hsl(40 12% 95%));
  --color-text-faded: light-dark(hsl(220 10% 40%), hsl(40 8% 65%));
  --color-primary: light-dark(hsl(212 97% 40%), hsl(212 80% 55%));
  --color-error: light-dark(hsl(10 100% 38%), hsl(10 100% 65%));
  --color-info: light-dark(hsl(217 91% 50%), hsl(217 91% 65%));

  --color-surface-1: light-dark(hsl(0 0% 100%), hsl(228 2% 7%));
  --color-surface-2: light-dark(hsl(240 12% 95%), hsl(228 2% 9%));
  --color-surface-3: light-dark(hsl(220 16% 93%), hsl(228 4% 16%));
  --color-code-bg: light-dark(hsl(220 16% 90%), hsl(228 4% 12%));

  --color-border-1: light-dark(hsl(220 24% 90%), hsl(230 10% 24%));
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
}

body {
  background-color: var(--color-surface-1);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: var(--font-size-3);
  line-height: 1.55;
  margin: 0 auto;
  max-inline-size: 860px;
  padding: var(--size-6) var(--size-4);
}

/* ─── Messages ───────────────────────────────────────────────────────── */

.message {
  display: flex;
  flex-direction: column;
  gap: var(--size-1);
  margin-block-end: var(--size-4);
  max-inline-size: 95%;
}

.message[data-role="user"] {
  align-self: flex-end;
  margin-inline-start: auto;
}

.message[data-role="assistant"] {
  margin-inline-end: auto;
  inline-size: 100%;
}

.message[data-role="system"] {
  align-self: center;
  margin-inline: auto;
  max-inline-size: 90%;
}

.role {
  color: var(--color-text-faded);
  font-size: var(--font-size-0);
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

/* Bubble around assistant/user text */
.content {
  background-color: var(--color-surface-3);
  border-radius: var(--radius-3);
  padding: var(--size-2-5) var(--size-3);
  word-break: break-word;
}

.message[data-role="user"] .content {
  background-color: var(--color-primary);
  color: white;
}

.content > p { margin-block: 0.4em; }
.content > p:first-child { margin-block-start: 0; }
.content > p:last-child { margin-block-end: 0; }

.content ul, .content ol {
  margin-block: 0.4em;
  padding-inline-start: 1.4em;
}
.content ul { list-style-type: disc; }
.content ol { list-style-type: decimal; }
.content li { margin-block: 0.15em; }

.content code {
  background-color: var(--color-code-bg);
  border-radius: var(--radius-1);
  font-family: var(--font-mono);
  font-size: 0.9em;
  padding: 0.1em 0.35em;
}

.content pre {
  background-color: var(--color-code-bg);
  border-radius: var(--radius-2);
  margin-block: 0.5em;
  overflow-x: auto;
  padding: var(--size-2);
}

.content pre code {
  background-color: transparent;
  font-size: var(--font-size-1);
  padding: 0;
}

.content h1, .content h2, .content h3, .content h4 {
  font-weight: 600;
  margin-block: 0.6em 0.3em;
}
.content h1 { font-size: 1.2em; }
.content h2 { font-size: 1.1em; }
.content h3 { font-size: 1.05em; }

.content blockquote {
  border-inline-start: 3px solid var(--color-border-1);
  color: var(--color-text-faded);
  margin-block: 0.4em;
  margin-inline: 0;
  padding-inline-start: var(--size-3);
}

.content table {
  border-collapse: collapse;
  font-size: var(--font-size-1);
  margin-block: 0.5em;
}
.content th, .content td {
  border: 1px solid var(--color-border-1);
  padding: var(--size-1) var(--size-2);
  text-align: start;
}
.content th { font-weight: 600; }

a {
  color: var(--color-primary);
  text-decoration: underline;
}

/* User bubble inverts link/code colors so they read on the primary fill */
.message[data-role="user"] .content a,
.message[data-role="user"] .content code {
  color: inherit;
}
.message[data-role="user"] .content code {
  background-color: rgba(255, 255, 255, 0.18);
}

/* System chip — centered, italic, info-tinted */
.system-content {
  background-color: light-dark(hsl(217 80% 95%), color-mix(in srgb, var(--color-info), transparent 85%));
  border: 1px solid light-dark(hsl(217 60% 85%), color-mix(in srgb, var(--color-info), transparent 70%));
  border-radius: var(--radius-3);
  color: light-dark(hsl(217 30% 35%), color-mix(in srgb, var(--color-text), transparent 20%));
  font-size: var(--font-size-1);
  font-style: italic;
  padding: var(--size-2) var(--size-3);
  text-align: center;
}

/* ─── Tool bursts ────────────────────────────────────────────────────── */

.tool-burst {
  background-color: var(--color-surface-2);
  border: 1px solid var(--color-border-1);
  border-radius: var(--radius-3);
  font-size: var(--font-size-2);
  margin-block: var(--size-2);
  overflow: hidden;
}

.tool-burst > summary {
  align-items: center;
  color: var(--color-text);
  cursor: pointer;
  display: flex;
  font-family: var(--font-mono);
  font-size: var(--font-size-1);
  gap: var(--size-2);
  list-style: none;
  padding: var(--size-1-5) var(--size-2-5);
  user-select: none;
}

.tool-burst > summary::-webkit-details-marker { display: none; }
.tool-burst > summary::marker { content: ""; }

.tool-burst > summary::before {
  color: var(--color-text-faded);
  content: "▸";
  display: inline-block;
  font-size: 0.8em;
  inline-size: 1em;
  transition: transform 120ms ease;
}

.tool-burst[open] > summary::before {
  transform: rotate(90deg);
}

.tool-burst-nested {
  background-color: transparent;
  border: none;
  margin-block: var(--size-1);
}

.tool-call {
  border-block-start: 1px solid var(--color-border-1);
  display: flex;
  flex-direction: column;
  gap: var(--size-1);
  padding: var(--size-2) var(--size-2-5);
}

.tool-burst-nested .tool-call {
  border-block-start: none;
  padding-block-start: 0;
}

.tool-call-header {
  align-items: center;
  display: flex;
  gap: var(--size-2);
  justify-content: space-between;
}

.tool-call-name {
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--font-size-1);
  font-weight: 500;
}

.tool-call-state {
  color: var(--color-text-faded);
  font-family: var(--font-mono);
  font-size: var(--font-size-0);
}

.tool-call[data-state="output-error"] .tool-call-state { color: var(--color-error); }
.tool-call[data-state="output-denied"] .tool-call-state { color: var(--color-error); }

.tool-call-children {
  display: flex;
  flex-direction: column;
  gap: var(--size-1);
  padding-inline-start: var(--size-2);
}

.tool-input,
.tool-output,
.tool-error {
  background-color: var(--color-code-bg);
  border-radius: var(--radius-1);
  font-family: var(--font-mono);
  font-size: var(--font-size-0);
  margin: 0;
  max-block-size: 400px;
  overflow: auto;
  padding: var(--size-2);
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-error { color: var(--color-error); }

.reasoning {
  color: var(--color-text-faded);
  font-family: var(--font-mono);
  font-size: var(--font-size-0);
  line-height: 1.45;
  white-space: pre-wrap;
}

/* ─── Inline images ──────────────────────────────────────────────────── */

.message-images {
  display: flex;
  flex-wrap: wrap;
  gap: var(--size-2);
}

.message-image {
  border: 1px solid var(--color-border-1);
  border-radius: var(--radius-2);
  display: block;
  max-block-size: 300px;
  max-inline-size: 100%;
  object-fit: contain;
}

/* ─── Artifacts ──────────────────────────────────────────────────────── */

.artifact-ref {
  align-items: center;
  background-color: var(--color-surface-2);
  border: 1px solid var(--color-border-1);
  border-radius: var(--radius-2);
  display: flex;
  font-size: var(--font-size-1);
  gap: var(--size-2);
  justify-content: space-between;
  padding: var(--size-1-5) var(--size-2-5);
}

.artifact-title {
  color: var(--color-text);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-download {
  color: var(--color-primary);
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-0);
  text-decoration: none;
}
.artifact-download:hover { text-decoration: underline; }

.artifact-unavailable {
  color: var(--color-text-faded);
  font-size: var(--font-size-0);
  font-style: italic;
}

.artifacts {
  border-block-start: 1px solid var(--color-border-1);
  margin-block-start: var(--size-6);
  padding-block-start: var(--size-4);
}

.artifacts h2 {
  font-size: var(--font-size-3);
  font-weight: 600;
  margin-block: 0 var(--size-2);
}

.artifact-list {
  display: flex;
  flex-direction: column;
  gap: var(--size-1-5);
  list-style: none;
  margin: 0;
  padding: 0;
}

@media print {
  body { max-inline-size: none; }
  .tool-burst[open] > summary::before { transform: rotate(90deg); }
  .tool-burst:not([open]) > summary::before { transform: none; }
  .tool-burst > summary { cursor: default; }
}
`;

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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat ${escapeHtml(titleId)}</title>
<style>${EXPORT_STYLES}</style>
</head>
<body>
${messageHtml}
${artifactHtml}
</body>
</html>
`;
}
