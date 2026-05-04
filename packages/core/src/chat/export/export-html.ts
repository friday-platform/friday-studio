/**
 * Server-side renderer that turns a {@link Chat} into a self-contained HTML
 * transcript. Tracer-bullet implementation: text segments only, role label,
 * no CSS, no markdown, no tool calls, no images. Subsequent tasks (T13–T17)
 * fill in tool-call cards, markdown, images, system chips, and styling.
 *
 * @module
 */

import type { ArtifactSummary } from "../../artifacts/model.ts";
import type { Chat } from "./../storage.ts";
import { buildSegments } from "./render.ts";

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
 * Render a {@link Chat} to a complete HTML document string. The second
 * `_artifacts` parameter is reserved for T16 (artifact bundling); the
 * tracer-bullet renderer ignores it but the signature is stable so callers
 * don't have to change when artifact rendering lands.
 */
export function renderChatToHTML(chat: Chat, _artifacts: ArtifactSummary[]): string {
  const titleId = chat.id.slice(0, 8);
  const messageHtml = chat.messages
    .map((msg) => {
      const segments = buildSegments(msg);
      const text = segments
        .filter((s): s is { type: "text"; content: string } => s.type === "text")
        .map((s) => s.content)
        .join("");
      return `<div class="message" data-role="${escapeHtml(msg.role)}">
  <div class="role">${escapeHtml(msg.role)}</div>
  <div class="content">${escapeHtml(text)}</div>
</div>`;
    })
    .join("\n");

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
