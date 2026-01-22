import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import {
  ArtifactDataSchema,
  escapeHTML,
  renderTableHTML,
  renderWorkspacePlanHTML,
  type ArtifactData,
  type CalendarSchedule,
  type FileData,
  type TableData,
  type WorkspacePlan,
} from "@atlas/core/artifacts";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { formatMessage } from "../modules/messages/format.ts";
import { markdownToHTML } from "./markdown.ts";
import { openUrl } from "./tauri-loader.ts";

/** Double chevron SVG icon for expand/collapse buttons */
const DOUBLE_CHEVRON_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 4L8 8L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M4 8L8 12L12 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

/**
 * Uploads chat HTML via atlasd share endpoint and opens the share URL.
 * The share service returns a public URL for viewing the shared chat.
 */
export async function shareChat(messages: AtlasUIMessage[], title?: string): Promise<void> {
  const html = await generateChatHTML(messages, title);
  const daemonUrl = getAtlasDaemonUrl();

  const response = await fetch(`${daemonUrl}/api/share`, {
    method: "POST",
    headers: { "Content-Type": "text/html" },
    body: html,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    console.error(`Failed to share chat: ${body.error ?? `HTTP ${response.status}`}`);
    throw new Error("Failed to share chat");
  }

  const data = (await response.json()) as { id: string; url: string };

  // Use Tauri's openUrl in desktop app, fallback to window.open in browser
  if (openUrl) {
    await openUrl(data.url);
  } else {
    globalThis.open(data.url, "_blank");
  }
}

/**
 * Extracts all artifact IDs from display_artifact tool calls in messages.
 */
function extractArtifactIds(messages: AtlasUIMessage[]): string[] {
  const artifactIds: string[] = [];

  for (const message of messages) {
    for (const part of message.parts) {
      const formatted = formatMessage(message, part);
      if (
        formatted?.type === "tool_call" &&
        formatted.metadata?.toolName === "display_artifact" &&
        typeof formatted.metadata?.artifactId === "string"
      ) {
        artifactIds.push(formatted.metadata.artifactId);
      }
    }
  }

  // Return unique IDs
  return [...new Set(artifactIds)];
}

/**
 * Fetches artifacts by ID from the API.
 * Returns a map of artifact ID to artifact data.
 * Failures are logged but don't break the flow.
 */
async function fetchArtifacts(artifactIds: string[]): Promise<Map<string, ArtifactData>> {
  const artifacts = new Map<string, ArtifactData>();

  if (artifactIds.length === 0) {
    return artifacts;
  }

  await Promise.all(
    artifactIds.map(async (id) => {
      try {
        const result = (await parseResult(
          client.artifactsStorage[":id"].$get({ param: { id }, query: {} }),
        )) as { ok: boolean; data: { artifact: { data: unknown } } };

        if (result.ok) {
          const parsed = ArtifactDataSchema.safeParse(result.data.artifact.data);
          if (parsed.success) {
            artifacts.set(id, parsed.data);
          }
        }
      } catch (error) {
        console.error(`Failed to fetch artifact ${id}:`, error);
      }
    }),
  );

  return artifacts;
}

async function generateChatHTML(messages: AtlasUIMessage[], title?: string): Promise<string> {
  // Extract and fetch all artifacts before rendering
  const artifactIds = extractArtifactIds(messages);
  const artifacts = await fetchArtifacts(artifactIds);

  const messagesHTML = messages
    .map((message) => renderMessage(message, artifacts))
    .filter(Boolean)
    .join("\n");

  const displayTitle = title ? `Friday Chat - ${escapeHTML(title)}` : "Friday Chat";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${displayTitle}</title>
  <style>
${getEmbeddedStyles()}
  </style>
  <!-- Google Analytics -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-NLLF9SE37C"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('consent', 'default', {
      analytics_storage: 'granted',
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted'
    });
    gtag('js', new Date());
    gtag('config', 'G-NLLF9SE37C');
  </script>
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

function renderMessage(message: AtlasUIMessage, artifacts: Map<string, ArtifactData>): string {
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

      // Handle display_artifact tool calls - render the artifact
      if (
        formatted.type === "tool_call" &&
        formatted.metadata?.toolName === "display_artifact" &&
        typeof formatted.metadata?.artifactId === "string"
      ) {
        const artifact = artifacts.get(formatted.metadata.artifactId);
        if (artifact) {
          return renderArtifactHTML(artifact);
        }
      }

      // Skip other tool calls, thinking, and non-visible parts
      return "";
    })
    .filter(Boolean)
    .join("\n");

  return parts;
}

/**
 * Routes artifact rendering to the appropriate type-specific renderer.
 * Uses shared core HTML renderers from @atlas/core/artifacts and wraps
 * them with collapsible details/summary elements for the share UI.
 */
function renderArtifactHTML(artifact: ArtifactData): string {
  switch (artifact.type) {
    case "workspace-plan":
      return wrapPlanArtifact(artifact.data);
    case "summary":
      return wrapSummaryArtifact(artifact.data);
    case "slack-summary":
      return wrapSummaryArtifact(artifact.data, "slack");
    case "table":
      return wrapTableArtifact(artifact.data);
    case "calendar-schedule":
      return wrapScheduleArtifact(artifact.data);
    case "file":
      return wrapFileArtifact(artifact.data);
    default:
      return "";
  }
}

/**
 * Wraps a workspace plan artifact.
 * Matches Atlas Web Client workspace-plan.svelte styling exactly:
 * - Header with "Plan" left, "Expand" right on SAME LINE
 * - Content visible with max-height and gradient fade
 * - Checkbox hack for expand/collapse
 */
function wrapPlanArtifact(plan: WorkspacePlan): string {
  const coreHTML = renderWorkspacePlanHTML(plan);
  const planId = `plan-${Math.random().toString(36).slice(2, 9)}`;

  return `
      <article class="message assistant">
        <div class="artifact-plan">
          <input type="checkbox" id="${planId}" class="plan-toggle" />
          <header>
            <span>Plan</span>
            <label for="${planId}" class="expand-btn">
              <span class="expand-text">Expand</span>
              <span class="collapse-text">Collapse</span>
            </label>
          </header>
          <div class="plan-content">
            ${coreHTML}
          </div>
        </div>
      </article>`;
}

/**
 * Wraps a summary artifact.
 * Matches Atlas Web Client summary.svelte styling exactly:
 * - Header with "Summary" left, "Expand" right on SAME LINE
 * - Content visible with max-height and gradient fade
 * - Checkbox hack for expand/collapse
 */
function wrapSummaryArtifact(data: string, source?: "slack"): string {
  const coreHTML = markdownToHTML(data);
  const sourceLabel = source === "slack" ? "Slack Summary" : "Summary";
  const summaryId = `summary-${Math.random().toString(36).slice(2, 9)}`;

  return `
      <article class="message assistant">
        <div class="artifact-summary">
          <input type="checkbox" id="${summaryId}" class="summary-toggle" />
          <header>
            <h2>${sourceLabel}</h2>
            <label for="${summaryId}" class="expand-btn">
              <span class="expand-text">Expand</span>
              <span class="collapse-text">Collapse</span>
            </label>
          </header>
          <div class="summary-content">
            ${coreHTML}
          </div>
        </div>
      </article>`;
}

/**
 * Wraps a table artifact.
 * Uses checkbox hack for CSS-only expand/collapse with gradient overlay,
 * matching the Atlas Web Client document.svelte styling exactly.
 */
function wrapTableArtifact(data: TableData): string {
  const coreHTML = renderTableHTML(data);
  const tableId = `table-${Math.random().toString(36).slice(2, 9)}`;

  return `
      <article class="message assistant">
        <div class="artifact-table">
          <input type="checkbox" id="${tableId}" class="table-toggle" />
          <header>
            <h2>Table</h2>
          </header>
          <div class="table-contents">
            <div class="table-scroll-wrapper">
              ${coreHTML}
            </div>
          </div>
          <label for="${tableId}" class="table-expand-overlay">
            <span class="expand-button">
              ${DOUBLE_CHEVRON_SVG}
              <span class="expand-text">Expand</span>
              <span class="collapse-text">Collapse</span>
            </span>
          </label>
        </div>
      </article>`;
}

/**
 * Wraps a schedule artifact (rendered inline, no collapse - matches schedule.svelte).
 * schedule.svelte displays events inline with a header showing weekday + date.
 */
function wrapScheduleArtifact(data: CalendarSchedule): string {
  if (!data.events || data.events.length === 0) {
    return `
      <article class="message assistant">
        <div class="artifact-schedule">
          <p class="no-events">No events scheduled.</p>
        </div>
      </article>`;
  }

  // Get date from first event for the header (like schedule.svelte)
  const firstEvent = data.events[0];
  if (!firstEvent) {
    return "";
  }
  const dateObj = new Date(firstEvent.startDate);
  const weekday = dateObj.toLocaleDateString(undefined, { weekday: "long" });
  const dateStr = dateObj.toLocaleDateString(undefined, { month: "long", day: "numeric" });

  // Render events inline (simplified from the grid view)
  const eventsHTML = data.events
    .map((event) => {
      const start = new Date(event.startDate);
      const end = new Date(event.endDate);
      const timeStr =
        `${start.toLocaleTimeString(undefined, { hour: "numeric", minute: "numeric" })} - ${end.toLocaleTimeString(undefined, { hour: "numeric", minute: "numeric" })}`
          .replaceAll("AM", "am")
          .replaceAll("PM", "pm");
      return `
        <div class="schedule-event">
          <span class="event-time">${escapeHTML(timeStr)}</span>
          <span class="event-name">${escapeHTML(event.eventName)}</span>
        </div>`;
    })
    .join("");

  const sourceHTML =
    data.source && data.sourceUrl
      ? `<a href="${escapeHTML(data.sourceUrl)}" target="_blank" class="schedule-source-link">${escapeHTML(data.source)}</a>`
      : data.source
        ? `<span class="schedule-source-text">${escapeHTML(data.source)}</span>`
        : "";

  return `
      <article class="message assistant">
        <div class="artifact-schedule">
          <header class="schedule-header">
            <div class="schedule-date-info">
              <h2 class="schedule-weekday">${escapeHTML(weekday)}</h2>
              <time class="schedule-date">${escapeHTML(dateStr)}</time>
            </div>
            ${sourceHTML ? `<div class="schedule-source">${sourceHTML}</div>` : ""}
          </header>
          <div class="schedule-events">
            ${eventsHTML}
          </div>
        </div>
      </article>`;
}

/**
 * Wraps a file artifact with checkbox hack pattern (matches file.svelte / document.svelte pattern).
 * Uses surface-2 background, gradient overlay, and double-chevron expand button.
 */
function wrapFileArtifact(data: FileData): string {
  const fileId = `file-${Math.random().toString(36).substring(2, 9)}`;
  const fileName = data.path.split("/").pop() ?? data.path;

  return `
      <article class="message assistant">
        <div class="artifact-file">
          <input type="checkbox" id="${fileId}" class="file-toggle" />
          <header>
            <h2>${escapeHTML(fileName)}</h2>
          </header>
          <div class="file-contents">
            <div class="file-content-inner">
              <p class="file-note">File content not available in shared view</p>
              <p class="file-path">${escapeHTML(data.path)}</p>
              <p class="file-type">${escapeHTML(data.mimeType)}</p>
            </div>
          </div>
          <label for="${fileId}" class="file-expand-overlay">
            <span class="expand-button">
              ${DOUBLE_CHEVRON_SVG}
              <span class="expand-text">Expand</span>
              <span class="collapse-text">Collapse</span>
            </span>
          </label>
        </div>
      </article>`;
}

function getEmbeddedStyles(): string {
  return `
    :root {
      --color-surface-1: hsl(0 0% 100% / 1);
      --color-surface-2: hsl(41 3% 95% / 1);
      --color-border-1: hsl(300 1% 87% / 1);
      --color-text: hsl(230 32% 14% / 1);
      --color-red: hsl(5 60% 53% / 1);
      --color-blue: hsl(210 100% 50% / 1);
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
      max-width: 50rem;
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

    /* Plan artifact - matches Atlas Web Client workspace-plan.svelte exactly */
    .artifact-plan {
      border: 1px solid color-mix(in srgb, var(--color-border-1) 50%, transparent);
      border-radius: 0.5rem;
      overflow: hidden;
      position: relative;
    }

    .artifact-plan .plan-toggle {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }

    .artifact-plan header {
      align-items: center;
      display: flex;
      font-size: 0.875rem;
      justify-content: space-between;
      padding-top: 1.25rem;
      padding-left: 1.25rem;
      padding-right: 1.25rem;
      position: relative;
      z-index: 2;
    }

    .artifact-plan header span {
      font-weight: 450;
      opacity: 0.5;
    }

    .artifact-plan .expand-btn {
      cursor: pointer;
      opacity: 0.8;
    }

    .artifact-plan .expand-btn:hover {
      text-decoration: underline;
    }

    .artifact-plan .collapse-text {
      display: none;
    }

    .artifact-plan .plan-toggle:checked ~ header .expand-text {
      display: none;
    }

    .artifact-plan .plan-toggle:checked ~ header .collapse-text {
      display: inline;
    }

    .artifact-plan .plan-content {
      max-height: 6rem;
      overflow: hidden;
      padding: 0.5rem 1.25rem 1.25rem;
    }

    .artifact-plan .plan-toggle:checked ~ .plan-content {
      max-height: none;
      overflow: visible;
    }

    /* Gradient fade overlay */
    .artifact-plan .plan-content::after {
      background: linear-gradient(
        to top,
        var(--color-surface-1) 0%,
        transparent 100%
      );
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 5rem;
      width: 100%;
      z-index: 1;
      pointer-events: none;
    }

    .artifact-plan .plan-toggle:checked ~ .plan-content::after {
      display: none;
    }

    /* Plan content styling */
    .artifact-plan h1 {
      font-size: 1.75rem;
      font-weight: 600;
      line-height: 1.1;
      margin-bottom: 0.375rem;
    }

    .artifact-plan .purpose {
      color: color-mix(in srgb, var(--color-text) 70%, transparent);
      font-size: 1rem;
      line-height: 1.5;
      margin-bottom: 1rem;
    }

    .artifact-plan .job {
      margin-top: 1rem;
    }

    .artifact-plan .job h2 {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 0.25rem;
    }

    .artifact-plan .signal-description {
      color: color-mix(in srgb, var(--color-text) 70%, transparent);
      font-size: 0.875rem;
      margin-bottom: 0.5rem;
    }

    .artifact-plan .steps {
      list-style: none;
      padding-left: 0;
    }

    .artifact-plan .steps li {
      margin-top: 0.5rem;
    }

    .artifact-plan .steps li strong {
      font-weight: 500;
    }

    .artifact-plan .steps li p {
      color: color-mix(in srgb, var(--color-text) 70%, transparent);
      font-size: 0.875rem;
      line-height: 1.4;
    }

    /* Summary artifact - matches Atlas Web Client summary.svelte exactly */
    .artifact-summary {
      border: 1px solid color-mix(in srgb, var(--color-border-1) 50%, transparent);
      border-radius: 0.5rem;
      max-width: 80%;
      overflow: hidden;
      position: relative;
    }

    .artifact-summary .summary-toggle {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }

    .artifact-summary header {
      align-items: center;
      display: flex;
      font-size: 0.875rem;
      justify-content: space-between;
      padding-top: 1.25rem;
      padding-left: 1.25rem;
      padding-right: 1.25rem;
      position: relative;
      z-index: 2;
    }

    .artifact-summary header h2 {
      font-weight: 450;
      opacity: 0.5;
    }

    .artifact-summary .expand-btn {
      cursor: pointer;
      opacity: 0.8;
    }

    .artifact-summary .expand-btn:hover {
      text-decoration: underline;
    }

    .artifact-summary .collapse-text {
      display: none;
    }

    .artifact-summary .summary-toggle:checked ~ header .expand-text {
      display: none;
    }

    .artifact-summary .summary-toggle:checked ~ header .collapse-text {
      display: inline;
    }

    .artifact-summary .summary-content {
      max-height: 6rem;
      overflow: hidden;
      padding: 0.5rem 1.25rem 1.25rem;
      font-size: 1rem;
      line-height: 1.5;
    }

    .artifact-summary .summary-toggle:checked ~ .summary-content {
      max-height: none;
      overflow: visible;
    }

    /* Gradient fade overlay using ::after */
    .artifact-summary .summary-content::after {
      background: linear-gradient(
        to top,
        var(--color-surface-1) 0%,
        transparent 100%
      );
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 5rem;
      width: 100%;
      z-index: 1;
      pointer-events: none;
    }

    .artifact-summary .summary-toggle:checked ~ .summary-content::after {
      display: none;
    }

    .artifact-summary .summary-content p {
      margin-bottom: 0.5rem;
      opacity: 0.8;
    }

    .artifact-summary .summary-content ul,
    .artifact-summary .summary-content ol {
      margin-left: 1rem;
      margin-bottom: 0.375rem;
    }

    .artifact-summary .summary-content li {
      margin-bottom: 0.375rem;
      opacity: 0.8;
    }

    .artifact-summary .summary-content li li {
      opacity: 1;
    }

    .artifact-summary .summary-content strong {
      font-weight: 600;
    }

    .artifact-summary .summary-content a {
      color: var(--color-text);
      font-weight: 500;
      text-decoration: underline;
    }

    /* Table artifact - matches Atlas Web Client document.svelte exactly */
    .artifact-table {
      background-color: var(--color-surface-2);
      border-radius: 0.75rem;
      max-width: 100%;
      width: fit-content;
      overflow: hidden;
      padding: 0.125rem;
      position: relative;
    }

    .artifact-table .table-toggle {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }

    .artifact-table header {
      align-items: center;
      display: flex;
      height: 2.5rem;
      padding-left: 0.75rem;
      padding-right: 0.75rem;
    }

    .artifact-table header h2 {
      align-items: center;
      display: flex;
      gap: 0.25rem;
      font-size: 0.875rem;
      font-weight: normal;
    }

    .artifact-table .table-contents {
      background-color: var(--color-surface-1);
      border-radius: 0.625rem;
      max-height: 12rem;
      overflow: hidden;
      overscroll-behavior-x: none;
    }

    .artifact-table .table-toggle:checked ~ .table-contents {
      max-height: none;
      overflow: auto;
    }

    .artifact-table .table-scroll-wrapper {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    .artifact-table table {
      border-collapse: separate;
      border-spacing: 0;
      font-size: 0.875rem;
      white-space: nowrap;
    }

    .artifact-table th,
    .artifact-table td {
      border-bottom: 1px solid var(--color-border-1);
      padding: 0.5rem 0.75rem;
      text-align: left;
    }

    .artifact-table th {
      font-weight: 500;
      background-color: var(--color-surface-2);
      position: sticky;
      top: 0;
    }

    .artifact-table tr:last-child td {
      border-bottom: none;
    }

    /* Expand overlay - positioned absolutely over the table contents */
    .artifact-table .table-expand-overlay {
      align-items: flex-end;
      background: linear-gradient(to bottom, transparent, var(--color-surface-1) 90%);
      border-radius: 0.625rem;
      cursor: pointer;
      display: flex;
      justify-content: center;
      padding-bottom: 1rem;
      position: absolute;
      top: 2.5rem;
      right: 0.125rem;
      bottom: 0.125rem;
      left: 0.125rem;
      z-index: 1;
    }

    /* When expanded, move overlay to flow position below table */
    .artifact-table .table-toggle:checked ~ .table-expand-overlay {
      background: none;
      padding: 0.75rem;
      position: relative;
      top: auto;
      right: auto;
      bottom: auto;
      left: auto;
    }

    .artifact-table .expand-button {
      align-items: center;
      color: var(--color-blue);
      display: flex;
      gap: 0.25rem;
      font-size: 0.875rem;
      font-weight: 500;
    }

    .artifact-table .expand-button svg {
      transition: transform 0.2s ease;
    }

    .artifact-table .table-toggle:checked ~ .table-expand-overlay .expand-button svg {
      transform: rotate(180deg);
    }

    .artifact-table .collapse-text {
      display: none;
    }

    .artifact-table .table-toggle:checked ~ .table-expand-overlay .expand-text {
      display: none;
    }

    .artifact-table .table-toggle:checked ~ .table-expand-overlay .collapse-text {
      display: inline;
    }

    /* Schedule artifact - matches schedule.svelte (inline, no collapse) */
    .artifact-schedule {
      --border-color: color-mix(in oklch, #8B5CF6, var(--color-surface-1) 90%);
      max-width: 24rem;
    }

    .artifact-schedule .no-events {
      color: color-mix(in srgb, var(--color-text) 60%, transparent);
      font-style: italic;
    }

    .artifact-schedule .schedule-header {
      display: grid;
      grid-template-columns: 1fr max-content;
      grid-template-rows: auto auto;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 0.5rem;
      margin-bottom: 0.5rem;
    }

    .artifact-schedule .schedule-date-info {
      grid-column: 1;
    }

    .artifact-schedule .schedule-weekday {
      font-size: 1.75rem;
      font-weight: 600;
      line-height: 1.1;
      margin: 0;
    }

    .artifact-schedule .schedule-date {
      font-size: 0.875rem;
      font-weight: 450;
      opacity: 0.5;
    }

    .artifact-schedule .schedule-source {
      grid-column: 2;
      grid-row: 2;
      font-size: 0.75rem;
      opacity: 0.5;
    }

    .artifact-schedule .schedule-source-link {
      text-underline-offset: 2px;
      text-decoration: underline;
    }

    .artifact-schedule .schedule-source-link:hover {
      opacity: 1;
    }

    .artifact-schedule .schedule-events {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .artifact-schedule .schedule-event {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      padding: 0.25rem 0.5rem;
      background: var(--border-color);
      border-radius: 0.25rem;
    }

    .artifact-schedule .event-time {
      font-size: 0.75rem;
      font-weight: 450;
      opacity: 0.5;
      white-space: nowrap;
    }

    .artifact-schedule .event-name {
      font-size: 0.75rem;
      font-weight: 500;
      color: #8B5CF6;
    }

    @media (prefers-color-scheme: dark) {
      .artifact-schedule .event-name {
        color: color-mix(in oklch, #8B5CF6, var(--color-text) 65%);
      }
    }

    /* File artifact - matches file.svelte / document.svelte (checkbox hack pattern) */
    .artifact-file {
      background-color: var(--color-surface-2);
      border-radius: 0.75rem;
      max-width: 100%;
      width: fit-content;
      overflow: hidden;
      padding: 0.125rem;
      position: relative;
    }

    .artifact-file .file-toggle {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }

    .artifact-file header {
      align-items: center;
      display: flex;
      height: 2.5rem;
      padding-left: 0.75rem;
      padding-right: 0.75rem;
    }

    .artifact-file header h2 {
      align-items: center;
      display: flex;
      gap: 0.25rem;
      font-size: 0.875rem;
      font-weight: normal;
      font-family: var(--font-family-monospace);
    }

    .artifact-file .file-contents {
      background-color: var(--color-surface-1);
      border-radius: 0.625rem;
      max-height: 12rem;
      overflow: hidden;
      overscroll-behavior-x: none;
    }

    .artifact-file .file-toggle:checked ~ .file-contents {
      max-height: none;
      overflow: auto;
    }

    .artifact-file .file-content-inner {
      padding: 1rem;
    }

    .artifact-file .file-note {
      color: color-mix(in srgb, var(--color-text) 60%, transparent);
      font-style: italic;
      margin-bottom: 0.5rem;
    }

    .artifact-file .file-path {
      font-family: var(--font-family-monospace);
      font-size: 0.75rem;
      color: color-mix(in srgb, var(--color-text) 50%, transparent);
      margin: 0;
    }

    .artifact-file .file-type {
      font-size: 0.75rem;
      color: color-mix(in srgb, var(--color-text) 40%, transparent);
      margin: 0;
    }

    /* Expand overlay - positioned absolutely over the file contents */
    .artifact-file .file-expand-overlay {
      align-items: flex-end;
      background: linear-gradient(to bottom, transparent, var(--color-surface-1) 90%);
      border-radius: 0.625rem;
      cursor: pointer;
      display: flex;
      justify-content: center;
      padding-bottom: 1rem;
      position: absolute;
      top: 2.5rem;
      right: 0.125rem;
      bottom: 0.125rem;
      left: 0.125rem;
      z-index: 1;
    }

    /* When expanded, move overlay to flow position below file content */
    .artifact-file .file-toggle:checked ~ .file-expand-overlay {
      background: none;
      padding: 0.75rem;
      position: relative;
      top: auto;
      right: auto;
      bottom: auto;
      left: auto;
    }

    .artifact-file .expand-button {
      align-items: center;
      color: var(--color-blue);
      display: flex;
      gap: 0.25rem;
      font-size: 0.875rem;
      font-weight: 500;
    }

    .artifact-file .expand-button svg {
      transition: transform 0.2s ease;
    }

    .artifact-file .file-toggle:checked ~ .file-expand-overlay .expand-button svg {
      transform: rotate(180deg);
    }

    .artifact-file .collapse-text {
      display: none;
    }

    .artifact-file .file-toggle:checked ~ .file-expand-overlay .expand-text {
      display: none;
    }

    .artifact-file .file-toggle:checked ~ .file-expand-overlay .collapse-text {
      display: inline;
    }
  `;
}
