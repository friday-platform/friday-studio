import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { formatMessage } from "../modules/messages/format.ts";
import { markdownToHTML } from "../modules/messages/markdown-utils.ts";
import { openUrl } from "./tauri-loader.ts";

/**
 * Escapes HTML special characters to prevent XSS.
 * Handles the five characters that need escaping per HTML spec.
 */
const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHTML(str: string): string {
  return str.replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] ?? char);
}

/**
 * Uploads chat HTML via atlasd share endpoint and opens the share URL.
 * The share service returns a public URL for viewing the shared chat.
 */
export async function shareChat(messages: AtlasUIMessage[], title?: string): Promise<void> {
  const html = generateChatHTML(messages, title);
  const daemonUrl = getAtlasDaemonUrl();

  const response = await fetch(`${daemonUrl}/api/share`, {
    method: "POST",
    headers: { "Content-Type": "text/html" },
    body: html,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to share chat: ${response.statusText}`);
  }

  const data = (await response.json()) as { id: string; url: string };

  // Use Tauri's openUrl in desktop app, fallback to window.open in browser
  if (openUrl) {
    await openUrl(data.url);
  } else {
    globalThis.open(data.url, "_blank");
  }
}

function generateChatHTML(messages: AtlasUIMessage[], title?: string): string {
  const messagesHTML = messages
    .map((message) => renderMessage(message))
    .filter(Boolean)
    .join("\n");

  const displayTitle = title ? `Atlas Chat - ${escapeHTML(title)}` : "Atlas Chat";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${displayTitle}</title>
  <style>
${getEmbeddedStyles()}
  </style>
</head>
<body>
  <div class="chat-container">
    <header class="chat-header">
      <h1>${displayTitle}</h1>
      <time datetime="${new Date().toISOString()}">${new Date().toLocaleString()}</time>
    </header>
    <div class="messages">
${messagesHTML}
    </div>
  </div>
</body>
</html>`;
}

function renderMessage(message: AtlasUIMessage): string {
  const parts = message.parts
    .map((part) => {
      const formatted = formatMessage(message, part);
      if (!formatted) return "";

      if (formatted.type === "request" || formatted.type === "text") {
        const htmlContent = formatted.content ? markdownToHTML(formatted.content) : "";
        const isUser = formatted.type === "request";

        return `
      <article class="message ${isUser ? "user" : "assistant"}">
        <div class="${isUser ? "request" : "content"}">
          ${htmlContent}
        </div>
      </article>`;
      }

      if (formatted.type === "error") {
        return `
      <article class="message error">
        <div class="error-content">
          ${escapeHTML(formatted.content || "An error occurred")}
        </div>
      </article>`;
      }

      // Skip tool calls, thinking, and other non-visible parts
      return "";
    })
    .filter(Boolean)
    .join("\n");

  return parts;
}

function getEmbeddedStyles(): string {
  return `
    :root {
      --color-surface-1: hsl(0 0% 100% / 1);
      --color-surface-2: hsl(41 3% 95% / 1);
      --color-border-1: hsl(300 1% 87% / 1);
      --color-text: hsl(230 32% 14% / 1);
      --color-red: hsl(5 60% 53% / 1);
      --font-family-sans: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-family-monospace: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --color-surface-1: hsl(229 18% 12% / 1);
        --color-surface-2: hsl(233 17% 10% / 1);
        --color-border-1: hsl(0 0% 0% / 0.3);
        --color-text: hsl(40 12% 95% / 1);
      }
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--color-surface-1);
      color: var(--color-text);
      font-family: var(--font-family-sans);
      font-size: 0.9375rem;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }

    .chat-container {
      margin: 0 auto;
      max-width: 40rem;
      padding: 2rem 1rem;
    }

    .chat-header {
      border-bottom: 1px solid var(--color-border-1);
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      text-align: center;
    }

    .chat-header h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }

    .chat-header time {
      color: color-mix(in srgb, var(--color-text) 60%, transparent);
      font-size: 0.8125rem;
    }

    .messages {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .message {
      display: flex;
      justify-content: center;
    }

    .message.user {
      justify-content: flex-end;
    }

    .message .content {
      max-width: 100%;
    }

    .message .content p,
    .message .content ul,
    .message .content ol {
      margin-bottom: 0.375rem;
    }

    .message .content p:last-child,
    .message .content ul:last-child,
    .message .content ol:last-child {
      margin-bottom: 0;
    }

    .message .content ul {
      list-style-type: disc;
      padding-left: 1.5rem;
    }

    .message .content ol {
      list-style-type: decimal;
      padding-left: 1.5rem;
    }

    .message .content strong {
      font-weight: 600;
    }

    .message .content a {
      color: var(--color-text);
      text-decoration: underline;
    }

    .message .content code {
      background-color: var(--color-surface-2);
      border-radius: 0.25rem;
      color: var(--color-red);
      font-family: var(--font-family-monospace);
      font-size: 0.875rem;
      padding: 0.125rem 0.25rem;
    }

    .message .content pre {
      background-color: var(--color-surface-2);
      border-radius: 0.625rem;
      font-family: var(--font-family-monospace);
      font-size: 0.875rem;
      margin: 1rem 0;
      overflow-x: auto;
      padding: 1rem 1.5rem;
    }

    .message .content pre code {
      background: none;
      border-radius: 0;
      color: inherit;
      padding: 0;
    }

    .message .request {
      background-color: var(--color-surface-2);
      border-radius: 0.625rem;
      max-width: 90%;
      padding: 0.5rem 0.75rem;
    }

    .message .request p {
      font-size: 0.875rem;
      line-height: 1.35;
      word-break: break-word;
    }

    .message.error .error-content {
      background-color: color-mix(in srgb, var(--color-red) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--color-red) 30%, transparent);
      border-radius: 0.625rem;
      color: var(--color-red);
      padding: 0.75rem 1rem;
    }
  `;
}
