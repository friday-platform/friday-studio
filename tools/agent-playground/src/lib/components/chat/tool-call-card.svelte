<script lang="ts">
  import type { Component } from "svelte";
  import { Icons, IconSmall } from "@atlas/ui";
  import ArtifactCard from "./artifact-card.svelte";
  import ConnectCommunicator from "./connect-communicator.svelte";
  import ConnectService from "./connect-service.svelte";
  import DelegateToolCard from "./delegate-tool-card.svelte";
  import { jsonHighlighter } from "./json-highlighter";
  import {
    argPreview,
    formatDuration,
    isError,
    isInProgress,
    outputSummary,
  } from "./tool-call-utils";
  import type { ToolCallDisplay } from "./types";

  interface Props {
    call: ToolCallDisplay;
    onCredentialConnected?: (provider: string) => void;
    depth?: number;
  }

  const { call, onCredentialConnected, depth = 0 }: Props = $props();

  /* ─── Icon & color mapping ───────────────────────────────────────── */

  interface ToolMeta {
    icon: Component;
    label: string;
    color: string;
    category: "web" | "code" | "file" | "agent" | "memory" | "connect" | "generic";
  }

  function getToolMeta(name: string): ToolMeta {
    switch (name) {
      case "web_fetch":
        return { icon: Icons.GlobeAlt, label: "Fetching", color: "var(--blue-primary)", category: "web" };
      case "web_search":
        return { icon: IconSmall.Search, label: "Searching", color: "var(--blue-primary)", category: "web" };
      case "run_code":
        return { icon: Icons.CodeBracketSquare, label: "Running", color: "var(--green-primary)", category: "code" };
      case "read_file":
        return { icon: Icons.DocumentText, label: "Reading", color: "var(--yellow-primary)", category: "file" };
      case "write_file":
        return { icon: Icons.DocumentArrowUp, label: "Writing", color: "var(--yellow-primary)", category: "file" };
      case "list_files":
        return { icon: Icons.FolderOpen, label: "Listing", color: "var(--yellow-primary)", category: "file" };
      case "delegate":
        return { icon: Icons.RectangleStack, label: "Delegating", color: "var(--color-accent)", category: "agent" };
      case "load_skill":
        return { icon: Icons.Bolt, label: "Loading skill", color: "var(--yellow-primary)", category: "memory" };
      case "memory_save":
        return { icon: Icons.Bookmark, label: "Saving memory", color: "var(--color-accent)", category: "memory" };
      case "connect_service":
        return { icon: Icons.Link, label: "Connecting", color: "var(--text-faded)", category: "connect" };
      case "connect_communicator":
        return { icon: Icons.Link, label: "Connecting", color: "var(--text-faded)", category: "connect" };
      case "display_artifact":
        return { icon: Icons.DocumentText, label: "Displaying", color: "var(--color-accent)", category: "file" };
      case "artifacts_get":
        return { icon: Icons.DocumentText, label: "Reading artifact", color: "var(--color-accent)", category: "file" };
      case "artifacts_create":
        return { icon: Icons.DocumentArrowUp, label: "Saving artifact", color: "var(--color-accent)", category: "file" };
      case "parse_artifact":
        return { icon: Icons.DocumentText, label: "Parsing", color: "var(--color-accent)", category: "file" };
      case "list_capabilities":
        return { icon: Icons.RectangleStack, label: "Checking tools", color: "var(--text-faded)", category: "generic" };
      default:
        return { icon: Icons.RectangleStack, label: name, color: "var(--color-border-1)", category: "generic" };
    }
  }

  const meta = $derived(getToolMeta(call.toolName));

  /* ─── Action verb + preview ──────────────────────────────────────── */

  function getActionText(toolName: string, input: unknown, state: ToolCallDisplay["state"]): string {
    const preview = argPreview(toolName, input);
    if (isInProgress(state)) {
      const verb = getToolMeta(toolName).label;
      return preview ? `${verb} ${preview}` : verb;
    }
    if (isError(state)) {
      return preview ? `Failed ${preview}` : "Failed";
    }
    if (toolName === "list_capabilities") {
      const out = call.output;
      let count = 0;
      if (typeof out === "object" && out !== null) {
        const caps = (out as Record<string, unknown>).capabilities;
        if (Array.isArray(caps)) count = caps.length;
        else if (Array.isArray(out)) count = out.length;
      }
      return count > 0 ? `Found ${count} tool${count === 1 ? "" : "s"}` : "Checked tools";
    }
    return preview || outputSummary(toolName, call.output) || "";
  }

  const actionText = $derived(getActionText(call.toolName, call.input, call.state));

  /* ─── Row-2 meta (tool name + extra) ───────────────────────────────── */

  function getMetaText(toolName: string, input: unknown, output: unknown): string {
    const parts: string[] = [];
    if (toolName === "run_code" && typeof input === "object" && input !== null) {
      const lang = (input as Record<string, unknown>).language;
      if (typeof lang === "string") parts.push(lang);
    }
    const summary = outputSummary(toolName, output);
    if (summary && !isInProgress(call.state)) parts.push(summary);
    return parts.join(" · ");
  }

  const metaText = $derived(getMetaText(call.toolName, call.input, call.output));

  /* ─── Elapsed-time tracking ──────────────────────────────────────── */

  const callStartTimes = $state(new Map<string, number>());
  let elapsedTick = $state(0);

  $effect(() => {
    if (!isInProgress(call.state)) return;
    const interval = setInterval(() => elapsedTick++, 500);
    return () => clearInterval(interval);
  });

  function getElapsedMs(id: string): number | undefined {
    void elapsedTick;
    if (!isInProgress(call.state)) return undefined;
    const existing = callStartTimes.get(id);
    if (existing) return Date.now() - existing;
    callStartTimes.set(id, Date.now());
    return 0;
  }

  /* ─── Status badge ─────────────────────────────────────────────────── */

  function statusBadgeContent(
    state: ToolCallDisplay["state"],
    callId: string,
    durationMs?: number,
    errorText?: string,
  ): { text: string; tone: "neutral" | "blue" | "green" | "red" | "yellow" } {
    if (isInProgress(state)) {
      const elapsed = getElapsedMs(callId);
      return {
        text: elapsed !== undefined ? formatDuration(elapsed) : "…",
        tone: "blue",
      };
    }
    if (state === "output-available") {
      return {
        text: durationMs && durationMs > 0 ? formatDuration(durationMs) : "Done",
        tone: "green",
      };
    }
    if (state === "output-error") {
      return {
        text: errorText ?? "Failed",
        tone: "red",
      };
    }
    if (state === "output-denied") {
      return { text: "Denied", tone: "yellow" };
    }
    if (state === "approval-requested") {
      return { text: "Needs approval", tone: "yellow" };
    }
    return { text: state, tone: "neutral" };
  }

  const status = $derived(statusBadgeContent(call.state, call.toolCallId, call.durationMs, call.errorText));

  /* ─── Copy to clipboard ──────────────────────────────────────────── */

  function copyToClipboard(value: unknown, btn: HTMLButtonElement) {
    let text: string;
    if (typeof value === "string") {
      text = value;
    } else {
      try {
        text = JSON.stringify(value, null, 2);
      } catch {
        text = String(value);
      }
    }
    void navigator.clipboard.writeText(text).then(() => {
      const original = btn.textContent ?? "Copy";
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = original; }, 1500);
    });
  }

  /* ─── JSON formatting ────────────────────────────────────────────── */

  function formatRawOutput(output: unknown): string {
    let jsonStr: string;
    if (typeof output === "string") {
      try {
        const parsed: unknown = JSON.parse(output);
        jsonStr = JSON.stringify(parsed, null, 2);
      } catch {
        return output.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }
    } else {
      try {
        jsonStr = JSON.stringify(output, null, 2);
      } catch {
        return String(output).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }
    }
    return jsonHighlighter.codeToHtml(jsonStr, { lang: "json", theme: "atlas-json" });
  }

  /* ─── Connect service extraction ─────────────────────────────────── */

  const provider = $derived.by<string | null>(() => {
    if (
      call.toolName === "connect_service" &&
      call.input != null &&
      typeof call.input === "object" &&
      "provider" in call.input &&
      typeof (call.input as Record<string, unknown>).provider === "string"
    ) {
      return (call.input as Record<string, unknown>).provider as string;
    }
    return null;
  });

  /* ─── Connect communicator extraction ─────────────────────────────── */

  type CommunicatorKind = "slack" | "telegram" | "discord" | "teams" | "whatsapp";
  const KNOWN_KINDS: readonly CommunicatorKind[] = [
    "slack",
    "telegram",
    "discord",
    "teams",
    "whatsapp",
  ] as const;

  const communicatorKind = $derived.by<CommunicatorKind | null>(() => {
    if (call.toolName !== "connect_communicator") return null;
    if (call.input == null || typeof call.input !== "object") return null;
    const raw = (call.input as Record<string, unknown>).kind;
    if (typeof raw !== "string") return null;
    return KNOWN_KINDS.find((k) => k === raw) ?? null;
  });

  /* ─── Artifact display extraction ───────────────────────────────── */

  const artifactDisplay = $derived.by<{ artifactId: string } | null>(() => {
    if (call.toolName !== "display_artifact") return null;
    const inp = call.input;
    if (typeof inp !== "object" || inp === null) return null;
    const i = inp as Record<string, unknown>;
    if (typeof i.artifactId !== "string") return null;
    return { artifactId: i.artifactId };
  });
</script>

{#snippet jsonCopyBlock(label: string, data: unknown)}
  <div class="json-copy-wrapper">
    <button
      class="json-copy-btn"
      aria-label={`Copy ${label}`}
      onclick={(e: MouseEvent) => copyToClipboard(data, e.currentTarget as HTMLButtonElement)}
    >
      Copy
    </button>
    <pre>{@html formatRawOutput(data)}</pre>
  </div>
{/snippet}

{#snippet outputDrawer(c: ToolCallDisplay)}
  {@const hasInput =
    c.input !== undefined &&
    typeof c.input === "object" &&
    c.input !== null &&
    Object.keys(c.input).length > 0}
  {@const hasOutput = c.output !== undefined}
  {@const hasError = c.errorText !== undefined}
  {#if hasInput || hasOutput || hasError}
    <div class="tool-card-drawer">
      {#if hasInput}
        <details class="tool-card-details">
          <summary>
            <span class="chevron-icon"><IconSmall.ChevronRight /></span>
            input
          </summary>
          {@render jsonCopyBlock("input", c.input)}
        </details>
      {/if}
      {#if hasOutput}
        <details class="tool-card-details">
          <summary>
            <span class="chevron-icon"><IconSmall.ChevronRight /></span>
            output
          </summary>
          {@render jsonCopyBlock("output", c.output)}
        </details>
      {/if}
      {#if hasError}
        <details class="tool-card-details" open>
          <summary>
            <span class="chevron-icon"><IconSmall.ChevronRight /></span>
            error
          </summary>
          <div class="json-copy-wrapper">
            <button
              class="json-copy-btn"
              aria-label="Copy error"
              onclick={(e: MouseEvent) => copyToClipboard(c.errorText, e.currentTarget as HTMLButtonElement)}
            >
              Copy
            </button>
            <pre class="error-text">{c.errorText}</pre>
          </div>
        </details>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet cardBody(c: ToolCallDisplay, m: ToolMeta)}
  <div class="tool-card-inner">
    <div class="tool-card-content">
      <!-- Row 1: icon + action + status -->
      <div class="tool-card-row-primary">
        <span class="tool-card-icon" aria-hidden="true">
          <m.icon />
        </span>
        <span class="tool-card-action" title={actionText}>{actionText}</span>
        <span class="tool-card-spacer"></span>
        <span
          class="status-indicator"
          class:status-blue={status.tone === "blue"}
          class:status-green={status.tone === "green"}
          class:status-red={status.tone === "red"}
          class:status-yellow={status.tone === "yellow"}
          class:status-neutral={status.tone === "neutral"}
          aria-label={status.text}
          title={status.text}
        >
          {#if status.tone === "blue"}
            <span class="status-dot" aria-hidden="true"></span>
          {:else if status.tone === "green"}
            <IconSmall.CheckCircle />
          {:else if status.tone === "red"}
            <IconSmall.XCircle />
          {:else if status.tone === "yellow"}
            <IconSmall.Clock />
          {:else}
            <span class="status-dot" aria-hidden="true"></span>
          {/if}
        </span>
      </div>
      <!-- Row 2: tool name + meta -->
      <div class="tool-card-row-secondary">
        <span class="tool-card-name">{c.toolName}</span>
        {#if metaText}
          <span class="tool-card-meta">{metaText}</span>
        {/if}
      </div>
    </div>
  </div>
{/snippet}

{#if provider != null}
  <div class="tool-card connect-service">
    <ConnectService {provider} onConnected={() => onCredentialConnected?.(provider)} />
  </div>
{:else if communicatorKind != null}
  <div class="tool-card connect-service">
    <ConnectCommunicator
      kind={communicatorKind}
      onConnected={() => onCredentialConnected?.(communicatorKind)}
    />
  </div>
{:else if call.toolName === "display_artifact"}
  <!-- Always render ArtifactCard for display_artifact tool calls — including
       during input-streaming when artifactId isn't parseable yet. The card
       sits in its loading state until artifactId lands, then fetches. This
       avoids a flash where the call would briefly render as a generic tool
       card before swapping to the artifact card. -->
  <ArtifactCard artifactId={artifactDisplay?.artifactId ?? ""} />
{:else if call.children && call.children.length > 0}
  <DelegateToolCard {call} {onCredentialConnected} {depth} />
{:else}
  <div
    class="tool-card"
    class:in-progress={isInProgress(call.state)}
    class:error={isError(call.state)}
  >
    {@render cardBody(call, meta)}
    {@render outputDrawer(call)}
  </div>
{/if}

<style>
  .tool-card {
    background-color: var(--surface);
    border-radius: var(--radius-2);
    font-size: var(--font-size-2);
    overflow: hidden;
  }

  .tool-card.with-children {
    background-color: transparent;
    border-radius: 0;
  }

  .tool-card-inner {
    display: flex;
    overflow: hidden;
    padding: var(--size-1) 0;
  }

  .tool-card-content {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 1px;
    min-inline-size: 0;
    padding: var(--size-1-5) var(--size-2-5);
  }

  /* ─── Row 1: icon + action + status ───────────────────────────────── */

  .tool-card-row-primary {
    align-items: center;
    display: flex;
    gap: var(--size-1-5);
    min-inline-size: 0;
  }

  .tool-card-icon {
    color: var(--text-faded);
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 14px;
    block-size: 14px;
    opacity: 0.5;
  }

  .tool-card-icon :global(svg) {
    inline-size: 100%;
    block-size: 100%;
  }

  .tool-card-action {
    color: var(--text-bright);
    flex: 1;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-card-spacer {
    flex: 0;
  }

  /* ─── Status badge (pill with icon + text) ────────────────────────── */

  .status-indicator {
    align-items: center;
    display: inline-flex;
    flex-shrink: 0;
    font-size: var(--font-size-0, 11px);
    gap: 5px;
    white-space: nowrap;
    --indicator-color: var(--text-faded);
  }

  .status-indicator.status-blue { color: var(--blue-primary); --indicator-color: var(--blue-primary); }
  .status-indicator.status-green { color: var(--green-primary); --indicator-color: var(--green-primary); }
  .status-indicator.status-red { color: var(--red-primary); --indicator-color: var(--red-primary); }
  .status-indicator.status-yellow { color: var(--yellow-primary); --indicator-color: var(--yellow-primary); }
  .status-indicator.status-neutral { color: var(--text-faded); --indicator-color: var(--text-faded); }

  .status-indicator :global(svg),
  .status-dot {
    flex-shrink: 0;
    inline-size: 12px;
    block-size: 12px;
  }

  .status-dot {
    border-radius: 50%;
    display: inline-block;
  }

  .status-indicator.status-blue .status-dot {
    background-color: var(--blue-primary);
    animation: status-pulse 1.2s ease-in-out infinite;
  }

  .status-indicator.status-neutral .status-dot {
    background-color: var(--text-faded);
    opacity: 0.5;
  }

  @keyframes status-pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  /* ─── Row 2: name + meta ───────────────────────────────────────────── */

  .tool-card-row-secondary {
    align-items: center;
    display: flex;
    gap: var(--size-1);
    min-inline-size: 0;
    padding-inline-start: calc(14px + var(--size-1-5));
  }

  .tool-card-name {
    color: var(--text-faded);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    font-weight: var(--font-weight-5);
    opacity: 0.6;
  }

  .tool-card-meta {
    color: var(--text-faded);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    opacity: 0.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ─── Output drawer ────────────────────────────────────────────────── */

  .tool-card-drawer {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: 0 var(--size-2-5) var(--size-1);
  }

  .tool-card-details {
    margin-block-start: 0;
  }

  .tool-card-details > summary {
    align-items: center;
    border-radius: var(--radius-1);
    color: var(--text-faded);
    cursor: pointer;
    display: flex;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    gap: var(--size-1);
    inline-size: max-content;
    list-style: none;
    padding: var(--size-1) var(--size-1-5);
    user-select: none;
    transition: background-color 100ms ease, color 100ms ease;
  }

  .tool-card-details > summary:hover {
    background-color: color-mix(in srgb, var(--color-border-1), transparent 50%);
    color: var(--text-bright);
  }

  .tool-card-details > summary::-webkit-details-marker {
    display: none;
  }

  .tool-card-details > summary .chevron-icon {
    color: var(--text-faded);
    display: inline-flex;
    inline-size: 12px;
    block-size: 12px;
    transition: transform 100ms ease;
  }

  .tool-card-details > summary .chevron-icon :global(svg) {
    inline-size: 100%;
    block-size: 100%;
  }

  .tool-card-details[open] > summary .chevron-icon {
    transform: rotate(90deg);
  }

  .tool-card-details[open] > summary {
    color: var(--text-bright);
  }

  /* ─── JSON copy block ──────────────────────────────────────────────── */

  .json-copy-wrapper {
    position: relative;
  }

  .json-copy-wrapper pre {
    background-color: var(--surface-bright);
    border-radius: var(--radius-1);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    margin-block-start: var(--size-1);
    max-block-size: 400px;
    overflow: auto;
    padding: var(--size-2);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .json-copy-wrapper pre.error-text {
    color: var(--red-primary);
  }

  .json-copy-btn {
    background-color: var(--surface-dark);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    color: var(--text-faded);
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    inset-block-start: var(--size-1);
    inset-inline-end: var(--size-1);
    opacity: 0;
    padding: 2px 8px;
    position: absolute;
    transition: opacity 100ms ease, color 100ms ease, background-color 100ms ease;
    z-index: 1;
  }

  .json-copy-wrapper:hover .json-copy-btn {
    opacity: 1;
  }

  .json-copy-btn:hover {
    background-color: var(--surface);
    color: var(--text-bright);
  }

  /* ─── Shiki JSON highlighting ──────────────────────────────────────── */

  .tool-card-details :global(pre.shiki) {
    background: transparent !important;
    margin: 0;
  }

  .tool-card-details :global(pre.shiki code) {
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
  }

  /* ─── Connect service override ─────────────────────────────────────── */

  .tool-card.connect-service {
    background: transparent;
    border: none;
    padding: 0;
  }
</style>
