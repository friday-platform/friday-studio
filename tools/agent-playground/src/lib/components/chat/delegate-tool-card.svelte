<script lang="ts">
  import type { Component } from "svelte";
  import { Icons, IconSmall, markdownToHTML } from "@atlas/ui";
  import ToolCallCard from "./tool-call-card.svelte";
  import { jsonHighlighter } from "./json-highlighter";
  import {
    argPreview,
    childrenAnyRunning,
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

  /* ─── Row-2 meta ─────────────────────────────────────────────────── */

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

  /* ─── Status badge ───────────────────────────────────────────────── */

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

  /* ─── Toggle latch ───────────────────────────────────────────────── */

  /** Undefined = no user choice yet; true/false = explicit open/close. */
  let userChoice: boolean | undefined = $state(undefined);

  /**
   * Once children have been observed running, latch this so the card stays
   * open after they finish.
   */
  let childrenWereRunning = $state(false);

  $effect(() => {
    if (call.children && childrenAnyRunning(call.children)) {
      childrenWereRunning = true;
    }
  });

  function handleToggleClick(e: Event, childrenRunning: boolean) {
    const current = userChoice ?? (childrenAnyRunning(call.children ?? []) || childrenWereRunning);
    userChoice = !current;
  }

  const delegateOpen = $derived.by(() => {
    if (userChoice !== undefined) return userChoice;
    if (call.children) return childrenAnyRunning(call.children) || childrenWereRunning;
    return false;
  });

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

{#if call.children && call.children.length > 0}
  {@const childrenRunning = childrenAnyRunning(call.children)}
  <div
    class="delegate-card"
    class:open={delegateOpen}
    class:in-progress={isInProgress(call.state)}
    class:error={isError(call.state)}
  >
    <div
      class="delegate-header"
      role="button"
      tabindex="0"
      onclick={(e) => handleToggleClick(e, childrenRunning)}
      onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") handleToggleClick(e, childrenRunning); }}
    >
      <div class="delegate-header-inner">
        <div class="delegate-header-content">
          <div class="delegate-row-primary">
            <span class="delegate-icon" aria-hidden="true">
              <meta.icon />
            </span>
            <span class="delegate-action" title={actionText}>{actionText}</span>
            <span class="delegate-spacer"></span>
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
          <div class="delegate-row-secondary">
            <span class="delegate-name">{call.toolName}</span>
            {#if metaText}
              <span class="delegate-meta">{metaText}</span>
            {/if}
          </div>
        </div>
      </div>
      <span class="delegate-chevron">
        {#if delegateOpen}
          <IconSmall.ChevronDown />
        {:else}
          <IconSmall.ChevronRight />
        {/if}
      </span>
    </div>
    {#if delegateOpen}
      {#if call.reasoning || call.progress}
        <div class="delegate-ephemeral">
          {#if call.reasoning}
            <div class="reasoning-feed">
              {#each call.reasoning.split("\n").filter(l => l.trim()) as line}
                <div class="reasoning-line">
                  <span class="reasoning-dot" aria-hidden="true"></span>
                  <span class="reasoning-text">{line}</span>
                </div>
              {/each}
            </div>
          {/if}
          {#if call.progress}
            <div class="progress-feed">
              {#each call.progress as line}
                <div class="progress-line">
                  <span class="progress-dot" aria-hidden="true"></span>
                  <span class="progress-text">{line}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      <div class="delegate-children" style="--depth: {depth}">
        {#each call.children as child (child.toolCallId || child.toolName)}
          <ToolCallCard call={child} {onCredentialConnected} depth={depth + 1} />
        {/each}
      </div>
      {#if call.delegateText}
        <details class="tool-card-details">
          <summary>
            <span class="chevron-icon"><IconSmall.ChevronRight /></span>
            response
          </summary>
          <div class="delegate-text markdown-body">
            {@html markdownToHTML(call.delegateText)}
          </div>
        </details>
      {/if}
      {@render outputDrawer(call)}
    {/if}
  </div>
{/if}

<style>
  .delegate-card {
    background-color: transparent;
    font-size: var(--font-size-2);
    overflow: hidden;
  }

  .delegate-header {
    align-items: center;
    cursor: pointer;
    display: flex;
    gap: var(--size-1);
    user-select: none;
  }

  .delegate-header-inner {
    display: flex;
    flex: 1;
    overflow: hidden;
    padding: var(--size-1) 0;
  }

  .delegate-header-content {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 1px;
    min-inline-size: 0;
    padding: var(--size-1-5) var(--size-2-5);
  }

  .delegate-row-primary {
    align-items: center;
    display: flex;
    gap: var(--size-1-5);
    min-inline-size: 0;
  }

  .delegate-icon {
    color: var(--text-faded);
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 14px;
    block-size: 14px;
    opacity: 0.5;
  }

  .delegate-icon :global(svg) {
    inline-size: 100%;
    block-size: 100%;
  }

  .delegate-action {
    color: var(--text-bright);
    flex: 1;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .delegate-spacer {
    flex: 0;
  }

  .delegate-chevron {
    color: var(--text-faded);
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 14px;
    block-size: 14px;
    margin-inline-start: var(--size-1);
    opacity: 0.5;
    transition: transform 150ms ease;
  }

  .delegate-chevron :global(svg) {
    inline-size: 100%;
    block-size: 100%;
  }

  .delegate-row-secondary {
    align-items: center;
    display: flex;
    gap: var(--size-1);
    min-inline-size: 0;
    padding-inline-start: calc(14px + var(--size-1-5));
  }

  .delegate-name {
    color: var(--text-faded);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    font-weight: var(--font-weight-5);
    opacity: 0.6;
  }

  .delegate-meta {
    color: var(--text-faded);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    opacity: 0.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  /* ─── Delegate ephemeral (reasoning + progress) ──────────────────── */

  .delegate-ephemeral {
    background-color: var(--surface-dark);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    margin-inline-start: var(--size-3);
    padding: var(--size-2) var(--size-2-5);
  }

  .reasoning-feed,
  .progress-feed {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .reasoning-line,
  .progress-line {
    align-items: baseline;
    display: flex;
    gap: var(--size-1-5);
  }

  .reasoning-dot,
  .progress-dot {
    background-color: var(--text-faded);
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 4px;
    block-size: 4px;
    opacity: 0.35;
  }

  .reasoning-text {
    color: var(--text);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    line-height: 1.45;
  }

  .progress-text {
    color: var(--text-faded);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    font-style: italic;
  }

  /* ─── Delegate text response ─────────────────────────────────────── */

  .delegate-text {
    background-color: var(--surface);
    font-size: var(--font-size-2);
    line-height: 1.55;
    margin-inline-start: var(--size-3);
    padding: var(--size-2) var(--size-2-5);
  }

  .delegate-text :global(p) {
    margin-block: 0.4em;
  }

  .delegate-text :global(p:first-child) {
    margin-block-start: 0;
  }

  .delegate-text :global(p:last-child) {
    margin-block-end: 0;
  }

  .delegate-text :global(ul) {
    list-style-type: disc;
    margin-block: 0.4em;
    padding-inline-start: 1.4em;
  }

  .delegate-text :global(ol) {
    list-style-type: decimal;
    margin-block: 0.4em;
    padding-inline-start: 1.4em;
  }

  .delegate-text :global(li) {
    margin-block: 0.15em;
  }

  .delegate-text :global(table) {
    border-collapse: collapse;
    font-size: var(--font-size-1);
    margin-block: 0.5em;
    max-inline-size: 100%;
  }

  .delegate-text :global(th),
  .delegate-text :global(td) {
    border: 1px solid var(--color-border-1);
    padding: var(--size-1) var(--size-2);
    text-align: start;
  }

  .delegate-text :global(th) {
    background-color: light-dark(hsl(220 12% 94%), color-mix(in srgb, var(--color-surface-3), transparent 30%));
    font-weight: var(--font-weight-6);
  }

  .delegate-text :global(tr:nth-child(even) td) {
    background-color: light-dark(hsl(220 12% 97%), color-mix(in srgb, var(--color-surface-2), transparent 50%));
  }

  /* ─── Nested children ────────────────────────────────────────────── */

  .delegate-children {
    display: none;
    flex-direction: column;
    gap: var(--size-1);
    margin-inline-start: calc(var(--size-3) + var(--depth, 0) * var(--size-1));
    padding-block-start: var(--size-1);
    padding-inline-start: var(--size-2);
  }

  .delegate-card.open > .delegate-children {
    display: flex;
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
</style>
