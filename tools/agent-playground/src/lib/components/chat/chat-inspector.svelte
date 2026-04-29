<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { tick } from "svelte";
  import { skillQueries } from "$lib/queries";
  import type { ChatMessage, ToolCallDisplay } from "./types";

  /** Flatten all tool calls from a message's chronological segments. */
  function allMessageToolCalls(msg: ChatMessage): ToolCallDisplay[] {
    return msg.segments.flatMap((s) => (s.type === "tool-burst" ? s.calls : []));
  }

  /** Extract the full text content from a message's text segments. */
  function messageTextContent(msg: ChatMessage): string {
    return msg.segments
      .filter((s): s is { type: "text"; content: string } => s.type === "text")
      .map((s) => s.content)
      .join("");
  }

  interface Props {
    open: boolean;
    chatId: string;
    messages: ChatMessage[];
    systemPromptContext: { timestamp: string; systemMessages: string[] } | null;
    workspaceName: string;
    /** Workspace id — drives the skills query for the Context tab. */
    workspaceId?: string | null;
    status: string;
  }

  const {
    open,
    chatId,
    messages,
    systemPromptContext,
    workspaceName,
    workspaceId,
    status,
  }: Props = $props();

  // Skills visible to this workspace (Context tab). Disabled when panel
  // closed or workspaceId unknown — no background fetches either way.
  const workspaceSkillsQuery = createQuery(() =>
    skillQueries.workspaceSkills(open && workspaceId ? workspaceId : null),
  );

  let activeTab: "context" | "tools" | "timeline" | "waterfall" | "prompt" = $state("context");
  let inspectorWidth = $state(350);
  let dragging = $state(false);

  function startDrag(e: PointerEvent) {
    e.preventDefault();
    dragging = true;
    const startX = e.clientX;
    const startWidth = inspectorWidth;

    function onMove(ev: PointerEvent) {
      // Dragging left edge → moving left increases width
      inspectorWidth = Math.max(250, Math.min(800, startWidth + (startX - ev.clientX)));
    }

    function onUp() {
      dragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /**
   * Debounced message snapshot — only updates when message COUNT changes
   * or status transitions, not on every streaming text-delta. This prevents
   * the inspector's derived computations from re-running hundreds of times
   * per second during streaming (which caused a 4.6s main thread block).
   */
  let snapshotMessages = $state<ChatMessage[]>([]);
  let lastSnapshotKey = "";
  $effect(() => {
    // Build a lightweight key from message count + status + tool states.
    // Triggers on: new message, status change (submitted→streaming→idle),
    // tool state transition. Does NOT trigger on every text-delta.
    const count = messages.length;
    const s = status;
    let toolKey = "";
    let hasContent = false;
    if (count > 0) {
      const last = messages[count - 1];
      const lastTools = last ? allMessageToolCalls(last) : [];
      if (lastTools.length > 0) {
        toolKey = lastTools.map((tc) => tc.state).join(",");
      }
      // Detect when content first appears (empty → non-empty)
      if (last && messageTextContent(last).length > 0) hasContent = true;
    }
    const key = `${count}:${s}:${toolKey}:${hasContent}`;
    if (key !== lastSnapshotKey) {
      lastSnapshotKey = key;
      snapshotMessages = messages;
    }
  });

  /**
   * Turn-level timing tracker. Records when each user message appears and
   * when the assistant response completes, building a per-turn waterfall.
   */
  interface TurnTiming {
    userMessageId: string;
    userText: string;
    startMs: number;
    firstResponseMs?: number;  // first assistant message part appeared
    endMs?: number;
    toolCalls: Array<{
      key: string;
      name: string;
      state: string;
      firstSeenMs: number;
      doneMs?: number;
    }>;
  }

  // Use an untracked store to avoid $effect read/write loops
  const timingsStore: TurnTiming[] = [];
  const rehydratedStore = new Set<string>();
  let storeInitialized = false;
  let turnTimingsVersion = $state(0);

  // Snapshot for rendering — only changes when version bumps
  let turnTimings = $state<TurnTiming[]>([]);

  // Track timing — ONLY when inspector is open to avoid performance impact
  $effect(() => {
    if (!open) return; // Critical: don't subscribe to messages when closed
    const msgs = snapshotMessages;
    const currentStatus = status;
    const now = Date.now();

    // First run: mark existing messages as rehydrated
    if (!storeInitialized) {
      storeInitialized = true;
      for (const m of msgs) rehydratedStore.add(m.id);
      return;
    }

    let changed = false;

    // Track NEW user messages
    for (const msg of msgs) {
      if (msg.role === "user" && !rehydratedStore.has(msg.id) && !timingsStore.find((t) => t.userMessageId === msg.id)) {
        timingsStore.push({
          userMessageId: msg.id,
          userText: messageTextContent(msg),
          startMs: now,
          toolCalls: [],
        });
        changed = true;
      }
    }

    // Update active turns
    for (const timing of timingsStore) {
      if (timing.endMs) continue;

      const userIdx = msgs.findIndex((m) => m.id === timing.userMessageId);
      if (userIdx < 0) continue;
      const assistantMsg = msgs.slice(userIdx + 1).find((m) => m.role === "assistant");

      // Track first response (assistant message appeared)
      if (assistantMsg && !timing.firstResponseMs) {
        timing.firstResponseMs = now;
        changed = true;
      }

      const assistantTools = assistantMsg ? allMessageToolCalls(assistantMsg) : [];
      if (assistantTools.length > 0) {
        for (const tc of assistantTools) {
          const tcKey = tc.toolCallId || tc.toolName;
          const existing = timing.toolCalls.find((t) => t.key === tcKey);
          if (!existing) {
            const isDone = tc.state === "output-available" || tc.state === "output-error";
            timing.toolCalls.push({
              key: tcKey,
              name: tc.toolName,
              state: tc.state,
              // If tool arrived already completed, backdate firstSeenMs to first response
              firstSeenMs: isDone ? (timing.firstResponseMs ?? timing.startMs) : now,
              doneMs: isDone ? now : undefined,
            });
            changed = true;
          } else if (existing.state !== tc.state) {
            existing.state = tc.state;
            if ((tc.state === "output-available" || tc.state === "output-error") && !existing.doneMs) {
              existing.doneMs = now;
            }
            changed = true;
          }
        }
      }

      // Close the turn when assistant has content and either:
      // - A subsequent user message exists (next turn started)
      // - Status is idle (streaming finished)
      // - Status is not streaming/submitted (catch-all for completed state)
      if (assistantMsg && messageTextContent(assistantMsg).length > 0) {
        const isLastUser = msgs.filter((m) => m.role === "user").at(-1)?.id === timing.userMessageId;
        const isDone = !isLastUser || currentStatus === "idle" || (currentStatus !== "streaming" && currentStatus !== "submitted");
        if (isDone) {
          timing.endMs = now;
          changed = true;
        }
      }
    }

    if (changed) {
      // Copy to reactive state for rendering
      turnTimings = timingsStore.map((t) => ({ ...t, toolCalls: [...t.toolCalls] }));
      turnTimingsVersion++;
    }
  });

  /** Computed waterfall data from turn timings. */
  const waterfallTurns = $derived.by(() => {
    if (!open) return [];
    // Subscribe to ticker so active turn durations update every 1s
    const _tick = waterfallTick;
    const now = Date.now();
    const turns: Array<{
      userText: string;
      totalMs: number;
      isActive: boolean;
      bars: Array<{
        label: string;
        durationMs: number;
        type: "tool" | "waiting" | "response";
        state: string;
        offsetPct: number;
        widthPct: number;
      }>;
    }> = [];

    for (const timing of turnTimings) {
      // Use current time for active turns
      const totalMs = (timing.endMs ?? now) - timing.startMs;
      if (totalMs <= 0) continue;
      const isActive = !timing.endMs;

      const bars: typeof turns[number]["bars"] = [];

      if (timing.toolCalls.length > 0) {
        // Add waiting phase (from user message to first tool call)
        const firstToolMs = Math.min(...timing.toolCalls.map((t) => t.firstSeenMs));
        const waitMs = firstToolMs - timing.startMs;
        if (waitMs > 100) {
          bars.push({
            label: "waiting",
            durationMs: waitMs,
            type: "waiting",
            state: "done",
            offsetPct: 0,
            widthPct: Math.max(2, (waitMs / totalMs) * 100),
          });
        }

        // Tool call bars
        for (const tc of timing.toolCalls) {
          const start = tc.firstSeenMs - timing.startMs;
          const dur = (tc.doneMs ?? now) - tc.firstSeenMs;
          bars.push({
            label: tc.name,
            durationMs: dur,
            type: "tool",
            state: tc.state,
            offsetPct: Math.max(0, (start / totalMs) * 100),
            widthPct: Math.max(2, (dur / totalMs) * 100),
          });
        }

        // Response phase (from last tool done to end)
        const lastToolDone = Math.max(...timing.toolCalls.map((t) => t.doneMs ?? now));
        const responseMs = (timing.endMs ?? now) - lastToolDone;
        if (responseMs > 100) {
          bars.push({
            label: "response",
            durationMs: responseMs,
            type: "response",
            state: isActive ? "streaming" : "done",
            offsetPct: Math.max(0, ((lastToolDone - timing.startMs) / totalMs) * 100),
            widthPct: Math.max(2, (responseMs / totalMs) * 100),
          });
        }
      } else if (timing.firstResponseMs) {
        // No tools but got first response — split into waiting + streaming/response
        const waitMs = timing.firstResponseMs - timing.startMs;
        const responseMs = (timing.endMs ?? now) - timing.firstResponseMs;
        if (waitMs > 50) {
          bars.push({
            label: "waiting",
            durationMs: waitMs,
            type: "waiting",
            state: "done",
            offsetPct: 0,
            widthPct: Math.max(2, (waitMs / totalMs) * 100),
          });
        }
        bars.push({
          label: isActive ? "streaming" : "response",
          durationMs: responseMs,
          type: "response",
          state: isActive ? "streaming" : "done",
          offsetPct: Math.max(0, (waitMs / totalMs) * 100),
          widthPct: Math.max(2, (responseMs / totalMs) * 100),
        });
      } else {
        // Still waiting for first response
        bars.push({
          label: "waiting",
          durationMs: totalMs,
          type: "waiting",
          state: "streaming",
          offsetPct: 0,
          widthPct: 100,
        });
      }

      turns.push({
        userText: timing.userText.slice(0, 40) + (timing.userText.length > 40 ? "..." : ""),
        totalMs,
        isActive,
        bars,
      });
    }
    return turns;
  });

  /** Slow ticker (1s) — ONLY when waterfall tab is active with open turns.
   * This is safe because waterfallTurns reads turnTimings (small array),
   * NOT messages (which updates on every text-delta). */
  let waterfallTick = $state(0);
  $effect(() => {
    const hasActiveTurns = turnTimings.some((t) => !t.endMs);
    if (open && activeTab === "waterfall" && hasActiveTurns) {
      const interval = setInterval(() => { waterfallTick++; }, 1000);
      return () => clearInterval(interval);
    }
  });

  function formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  /** Parse available tools from the system prompt context. */
  const availableTools = $derived.by(() => {
    if (!open || !systemPromptContext) return [];
    const tools: Array<{ name: string; description: string }> = [];
    for (const msg of systemPromptContext.systemMessages) {
      // Match tool definitions in system prompt — typically formatted as
      // "tool_name: description" or listed in a tools section
      const toolMatches = msg.matchAll(/^[-•]\s*\*\*(\w+)\*\*\s*[—–-]\s*(.+)$/gm);
      for (const m of toolMatches) {
        if (m[1] && m[2]) tools.push({ name: m[1], description: m[2].slice(0, 80) });
      }
      // Also match "tool: name" patterns from capability sections
      const capMatches = msg.matchAll(/`(\w+(?:_\w+)+)`/g);
      for (const m of capMatches) {
        if (m[1] && !tools.find((t) => t.name === m[1])) {
          tools.push({ name: m[1], description: "" });
        }
      }
    }
    return tools;
  });

  /** Model info extracted from system prompt. */
  const modelInfo = $derived.by(() => {
    if (!open || !systemPromptContext) return null;
    for (const msg of systemPromptContext.systemMessages) {
      // Look for model references
      const match = msg.match(/claude[- ](?:sonnet|opus|haiku)[- ]\d[- ]\d/i);
      if (match) return match[0];
    }
    return null;
  });

  /**
   * Latest assistant metadata — powers the Context tab "Active agent + model"
   * display. Walks from the end because the newest stamp is most accurate
   * (older messages may pre-date agentId/jobName being stamped).
   */
  const latestAssistantMetadata = $derived.by(() => {
    if (!open) return null;
    for (let i = snapshotMessages.length - 1; i >= 0; i--) {
      const m = snapshotMessages[i];
      if (m?.role === "assistant" && m.metadata) {
        return m.metadata;
      }
    }
    return null;
  });

  /**
   * Session-wide loaded skills. Aggregates `load_skill` tool calls across
   * every assistant turn (not just the latest) so the Context tab still
   * shows a skill that was loaded 10 turns ago. Keyed by skill name.
   */
  interface LoadedSkillEntry {
    name: string;
    firstTurn: number;
    loadCount: number;
    lastState: string;
    lintWarnings: Array<{ rule: string; message: string; severity: string }>;
  }
  const loadedSkills = $derived.by(() => {
    if (!open) return new Map<string, LoadedSkillEntry>();
    const out = new Map<string, LoadedSkillEntry>();
    let turnIdx = 0;
    for (const msg of snapshotMessages) {
      if (msg.role === "user") turnIdx++;
      if (msg.role !== "assistant") continue;
      const msgTools = allMessageToolCalls(msg);
      if (msgTools.length === 0) continue;
      for (const tc of msgTools) {
        if (tc.toolName !== "load_skill") continue;
        const inp = typeof tc.input === "object" && tc.input !== null
          ? (tc.input as Record<string, unknown>)
          : {};
        const nameRaw = typeof inp.name === "string" ? inp.name : null;
        if (!nameRaw) continue;
        const out_ = typeof tc.output === "object" && tc.output !== null
          ? (tc.output as Record<string, unknown>)
          : {};
        const rawWarnings = Array.isArray(out_.lintWarnings) ? out_.lintWarnings : [];
        const lintWarnings = rawWarnings.flatMap((w) => {
          if (typeof w !== "object" || w === null) return [];
          const wr = w as Record<string, unknown>;
          if (typeof wr.rule !== "string" || typeof wr.message !== "string") return [];
          return [{
            rule: wr.rule,
            message: wr.message,
            severity: typeof wr.severity === "string" ? wr.severity : "warn",
          }];
        });
        const prev = out.get(nameRaw);
        if (prev) {
          prev.loadCount += 1;
          prev.lastState = tc.state;
          if (lintWarnings.length > 0) prev.lintWarnings = lintWarnings;
        } else {
          out.set(nameRaw, {
            name: nameRaw,
            firstTurn: turnIdx,
            loadCount: 1,
            lastState: tc.state,
            lintWarnings,
          });
        }
      }
    }
    return out;
  });

  const visibleSkills = $derived(workspaceSkillsQuery.data ?? []);

  /** All unique tool names used across all assistant messages. */
  const usedTools = $derived.by(() => {
    if (!open) return new Set<string>();
    const names = new Set<string>();
    for (const msg of snapshotMessages) {
      for (const tc of allMessageToolCalls(msg)) {
        names.add(tc.toolName);
      }
    }
    return names;
  });

  /** All tool calls flattened with message context. */
  const allToolCalls = $derived.by(() => {
    if (!open) return [];
    const calls: Array<ToolCallDisplay & { messageId: string }> = [];
    for (const msg of snapshotMessages) {
      for (const tc of allMessageToolCalls(msg)) {
        calls.push({ ...tc, messageId: msg.id });
      }
    }
    return calls;
  });

  /** Timeline entries: messages + tool calls interleaved. */
  const timeline = $derived.by(() => {
    if (!open) return [];
    const entries: Array<{
      type: "user" | "assistant" | "tool";
      timestamp: number;
      content: string;
      toolName?: string;
      toolState?: string;
      duration?: string;
    }> = [];
    for (const msg of snapshotMessages) {
      if (msg.role === "user") {
        entries.push({
          type: "user",
          timestamp: msg.timestamp,
          content: messageTextContent(msg),
        });
      }
      if (msg.role === "assistant") {
        for (const seg of msg.segments) {
          if (seg.type === "tool-burst") {
            for (const tc of seg.calls) {
              entries.push({
                type: "tool",
                timestamp: msg.timestamp,
                content: argPreview(tc),
                toolName: tc.toolName,
                toolState: tc.state,
              });
            }
          }
          if (seg.type === "text" && seg.content.length > 0) {
            entries.push({
              type: "assistant",
              timestamp: msg.timestamp,
              content: seg.content,
            });
          }
        }
      }
    }
    return entries;
  });

  function argPreview(tc: ToolCallDisplay): string {
    if (typeof tc.input !== "object" || tc.input === null) return "";
    const obj = tc.input as Record<string, unknown>;
    const first = Object.values(obj).find((v) => typeof v === "string");
    if (typeof first === "string") return first.length > 50 ? first.slice(0, 50) + "..." : first;
    return "";
  }

  function stateIcon(state: string): string {
    if (state === "output-available") return "✓";
    if (state === "output-error" || state === "output-denied") return "✗";
    return "⟳";
  }

  function formatBytes(n: number): string {
    if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  }

  function genericPreview(inp: Record<string, unknown>): string {
    // Try common field names in priority order
    for (const key of ["prompt", "intent", "query", "name", "path", "url", "text"]) {
      const val = inp[key];
      if (typeof val === "string" && val.length > 0) {
        return val.length > 80 ? `${val.slice(0, 80)}…` : val;
      }
    }
    // Fall back to first string value
    for (const v of Object.values(inp)) {
      if (typeof v === "string" && v.length > 0) {
        return v.length > 80 ? `${v.slice(0, 80)}…` : v;
      }
    }
    return "";
  }

  /** Look up observed duration for a tool call from the waterfall timing store. */
  function getToolDurationMs(toolCallId: string): number | null {
    for (const turn of turnTimings) {
      const tc = turn.toolCalls.find((t) => t.key === toolCallId);
      if (tc && tc.doneMs) return tc.doneMs - tc.firstSeenMs;
    }
    return null;
  }

  const tabs = [
    { id: "context" as const, label: "Context" },
    { id: "tools" as const, label: "Tools" },
    { id: "timeline" as const, label: "Timeline" },
    { id: "waterfall" as const, label: "Waterfall" },
    { id: "prompt" as const, label: "Prompt" },
  ];
</script>

{#snippet callStatus(state: string)}
  {#if state === "output-available"}
    <span class="stat ok">OK</span>
  {:else if state === "output-error"}
    <span class="stat err">ERROR</span>
  {:else if state === "output-denied"}
    <span class="stat err">DENIED</span>
  {:else if state === "input-streaming"}
    <span class="stat running">streaming input</span>
  {:else if state === "input-available"}
    <span class="stat running">executing</span>
  {:else if state === "approval-requested"}
    <span class="stat warn">needs approval</span>
  {:else}
    <span class="stat running">{state}</span>
  {/if}
{/snippet}

{#if open}
  <div class="inspector" style="inline-size: {inspectorWidth}px; min-inline-size: {inspectorWidth}px;">
    <div
      class="resize-handle"
      class:active={dragging}
      onpointerdown={startDrag}
      role="separator"
      aria-orientation="vertical"
    ></div>
    <div class="inspector-tabs">
      {#each tabs as tab (tab.id)}
        <button
          class="tab"
          class:active={activeTab === tab.id}
          onclick={() => activeTab = tab.id}
        >
          {tab.label}
          {#if tab.id === "tools"}
            <span class="badge">{usedTools.size}</span>
          {/if}
          {#if tab.id === "timeline"}
            <span class="badge">{timeline.length}</span>
          {/if}
        </button>
      {/each}
    </div>

    <div class="inspector-body">
      {#if activeTab === "context"}
        <div class="section">
          <h4>Session</h4>
          <dl class="kv-list">
            <dt>Chat ID</dt>
            <dd class="mono">{chatId.slice(0, 8)}</dd>
            <dt>Workspace</dt>
            <dd>{workspaceName}</dd>
            <dt>Status</dt>
            <dd>
              <span class="status-dot" class:active={status === "streaming" || status === "submitted"}></span>
              {status}
            </dd>
            <dt>Messages</dt>
            <dd>{snapshotMessages.length}</dd>
            <dt>Tool Calls</dt>
            <dd>{allToolCalls.length}</dd>
          </dl>
        </div>

        <div class="section">
          <h4>Active Agent</h4>
          {#if latestAssistantMetadata}
            <dl class="kv-list">
              {#if latestAssistantMetadata.agentId}
                <dt>Agent</dt>
                <dd class="mono-sm">{latestAssistantMetadata.agentId}</dd>
              {/if}
              {#if latestAssistantMetadata.jobName}
                <dt>Job</dt>
                <dd class="mono-sm">{latestAssistantMetadata.jobName}</dd>
              {/if}
              {#if latestAssistantMetadata.provider}
                <dt>Provider</dt>
                <dd class="mono-sm">{latestAssistantMetadata.provider}</dd>
              {/if}
              {#if latestAssistantMetadata.modelId}
                <dt>Model</dt>
                <dd class="mono-sm">{latestAssistantMetadata.modelId}</dd>
              {/if}
              {#if !latestAssistantMetadata.agentId && !latestAssistantMetadata.modelId}
                <dt>—</dt><dd>no metadata stamped yet</dd>
              {/if}
            </dl>
          {:else}
            <div class="empty">Waiting for first assistant response.</div>
          {/if}
        </div>

        <div class="section">
          <h4>Skills</h4>
          {#if workspaceSkillsQuery.isLoading}
            <div class="empty">Loading…</div>
          {:else if visibleSkills.length === 0 && loadedSkills.size === 0}
            <div class="empty">No skills visible.</div>
          {:else}
            {#if loadedSkills.size > 0}
              <div class="sub-label">Loaded this session ({loadedSkills.size})</div>
              <ul class="skill-list-compact">
                {#each [...loadedSkills.values()] as entry (entry.name)}
                  <li class="skill-row-compact">
                    <span class="skill-name-compact mono-sm">{entry.name}</span>
                    <span class="skill-meta">
                      turn {entry.firstTurn}
                      {#if entry.loadCount > 1}· ×{entry.loadCount}{/if}
                    </span>
                    {#if entry.lintWarnings.length > 0}
                      <span class="stat warn" title={entry.lintWarnings.map((w) => `${w.rule}: ${w.message}`).join("\n")}>
                        ⚠ {entry.lintWarnings.length}
                      </span>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
            {#if visibleSkills.length > 0}
              <div class="sub-label">Available in workspace ({visibleSkills.length})</div>
              <ul class="skill-list-compact">
                {#each visibleSkills as skill (skill.skillId)}
                  <li class="skill-row-compact">
                    <span class="skill-name-compact mono-sm">
                      {skill.namespace}/{skill.name}
                    </span>
                    {#if skill.namespace === "friday"}
                      <span class="badge-system">system</span>
                    {/if}
                    {#if skill.disabled}
                      <span class="stat dim">disabled</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        </div>

        {#if systemPromptContext}
          <div class="section">
            <h4>System Prompt</h4>
            <dl class="kv-list">
              <dt>Captured</dt>
              <dd class="mono">{new Date(systemPromptContext.timestamp).toLocaleTimeString()}</dd>
              <dt>Parts</dt>
              <dd>{systemPromptContext.systemMessages.length}</dd>
              <dt>Chars</dt>
              <dd>{systemPromptContext.systemMessages.reduce((s, m) => s + m.length, 0).toLocaleString()}</dd>
            </dl>
          </div>
        {/if}

      {:else if activeTab === "tools"}
        {#if usedTools.size === 0}
          <div class="empty">No tool calls in this session.</div>
        {:else}
          <div class="section">
            <h4>Used Tools ({usedTools.size})</h4>
            <ul class="tool-list">
              {#each [...usedTools] as name (name)}
                {@const calls = allToolCalls.filter(tc => tc.toolName === name)}
                {@const ok = calls.filter(tc => tc.state === "output-available").length}
                {@const err = calls.filter(tc => tc.state === "output-error" || tc.state === "output-denied").length}
                <li class="tool-group">
                  <div class="tool-entry">
                    <span class="tool-name">{name}</span>
                    <span class="tool-stats">
                      <span class="stat ok">{ok}✓</span>
                      {#if err > 0}<span class="stat err">{err}✗</span>{/if}
                    </span>
                  </div>
                  {#if calls.length > 0}
                    <ul class="tool-call-details">
                      {#each calls as call (call.toolCallId)}
                        {@const inp = (typeof call.input === "object" && call.input !== null ? call.input : {}) as Record<string, unknown>}
                        {@const out = (typeof call.output === "object" && call.output !== null ? call.output : {}) as Record<string, unknown>}
                        {@const errorMsg = typeof out.error === "string" ? out.error : (call.errorText ?? null)}
                        <li class="call-detail">
                          {#if name === "web_fetch"}
                            {@const url = typeof inp.url === "string" ? inp.url : ""}
                            {@const format = typeof inp.format === "string" ? inp.format : "markdown"}
                            {@const timeoutMs = typeof inp.timeout_ms === "number" ? inp.timeout_ms : null}
                            {@const sourceUrl = typeof out.sourceUrl === "string" ? out.sourceUrl : ""}
                            {@const fromCache = out.fromCache === true}
                            {@const contentLen = typeof out.content === "string" ? out.content.length : 0}
                            {@const redirected = sourceUrl !== "" && url !== "" && sourceUrl !== url && sourceUrl !== url.replace(/^http:/, "https:")}
                            {@const fetchDuration = getToolDurationMs(call.toolCallId)}
                            <div class="call-headline" title={url}>
                              <span class="http-badge">GET</span>
                              {url}
                            </div>
                            <dl class="call-meta">
                              <dt>Status</dt>
                              <dd>{@render callStatus(call.state)}</dd>
                              {#if fetchDuration !== null}
                                <dt>Time</dt>
                                <dd>{formatMs(fetchDuration)}</dd>
                              {/if}
                              <dt>Format</dt>
                              <dd>{format}</dd>
                              {#if call.state === "output-available"}
                                <dt>Cache</dt>
                                <dd>{#if fromCache}<span class="stat ok">HIT</span>{:else}<span class="stat dim">MISS</span>{/if}</dd>
                              {/if}
                              {#if contentLen > 0}
                                <dt>Size</dt>
                                <dd>{formatBytes(contentLen)}</dd>
                              {/if}
                              {#if redirected}
                                <dt>Redirect</dt>
                                <dd class="mono-sm" title={sourceUrl}>{sourceUrl}</dd>
                              {/if}
                              {#if timeoutMs !== null && timeoutMs !== 30000}
                                <dt>Timeout</dt>
                                <dd>{(timeoutMs / 1000).toFixed(0)}s</dd>
                              {/if}
                            </dl>

                          {:else if name === "web_search"}
                            {@const query = typeof inp.query === "string" ? inp.query : ""}
                            {@const count = typeof inp.count === "number" ? inp.count : 10}
                            {@const results = Array.isArray(out.results) ? out.results : []}
                            <div class="call-headline" title={query}>
                              <span class="search-badge">Q</span>
                              {query}
                            </div>
                            <dl class="call-meta">
                              <dt>Status</dt>
                              <dd>{@render callStatus(call.state)}</dd>
                              <dt>Requested</dt>
                              <dd>{count} results</dd>
                              {#if results.length > 0}
                                <dt>Returned</dt>
                                <dd>{results.length} result{results.length === 1 ? "" : "s"}</dd>
                              {/if}
                            </dl>
                            {#if results.length > 0}
                              <ul class="search-results">
                                {#each results as r, ri (ri)}
                                  {@const rt = typeof r === "object" && r !== null ? r as Record<string, unknown> : {}}
                                  <li class="search-result">
                                    <span class="search-result-title">{typeof rt.title === "string" ? rt.title : ""}</span>
                                    <span class="search-result-url">{typeof rt.url === "string" ? rt.url : ""}</span>
                                  </li>
                                {/each}
                              </ul>
                            {/if}

                          {:else if name === "run_code"}
                            {@const language = typeof inp.language === "string" ? inp.language : ""}
                            {@const sourceLen = typeof inp.source === "string" ? inp.source.length : 0}
                            {@const exitCode = typeof out.exit_code === "number" ? out.exit_code : null}
                            {@const durationMs = typeof out.duration_ms === "number" ? out.duration_ms : null}
                            {@const stdoutLen = typeof out.stdout === "string" ? out.stdout.length : 0}
                            {@const stderrLen = typeof out.stderr === "string" ? out.stderr.length : 0}
                            {@const stdoutTrunc = out.stdout_truncated === true}
                            {@const stderrTrunc = out.stderr_truncated === true}
                            {@const timeoutMs = typeof inp.timeout_ms === "number" ? inp.timeout_ms : null}
                            <div class="call-headline">
                              <span class="lang-badge" class:python={language === "python"} class:javascript={language === "javascript"} class:bash={language === "bash"}>{language || "code"}</span>
                              {sourceLen > 0 ? `${sourceLen} chars` : ""}
                            </div>
                            <dl class="call-meta">
                              <dt>Status</dt>
                              <dd>{@render callStatus(call.state)}</dd>
                              {#if exitCode !== null}
                                <dt>Exit</dt>
                                <dd><span class={exitCode === 0 ? "stat ok" : "stat err"}>{exitCode}</span></dd>
                              {/if}
                              {#if durationMs !== null}
                                <dt>Duration</dt>
                                <dd>{formatMs(durationMs)}</dd>
                              {/if}
                              {#if stdoutLen > 0}
                                <dt>stdout</dt>
                                <dd>{formatBytes(stdoutLen)}{stdoutTrunc ? " (truncated)" : ""}</dd>
                              {/if}
                              {#if stderrLen > 0}
                                <dt>stderr</dt>
                                <dd class="stat err">{formatBytes(stderrLen)}{stderrTrunc ? " (truncated)" : ""}</dd>
                              {/if}
                              {#if timeoutMs !== null && timeoutMs !== 30000}
                                <dt>Timeout</dt>
                                <dd>{(timeoutMs / 1000).toFixed(0)}s</dd>
                              {/if}
                            </dl>

                          {:else if name === "read_file"}
                            {@const path = typeof inp.path === "string" ? inp.path : ""}
                            {@const sizeBytes = typeof out.size_bytes === "number" ? out.size_bytes : null}
                            {@const truncated = out.truncated === true}
                            <div class="call-headline mono-sm">{path}</div>
                            <dl class="call-meta">
                              <dt>Status</dt>
                              <dd>{@render callStatus(call.state)}</dd>
                              {#if sizeBytes !== null}
                                <dt>Size</dt>
                                <dd>{formatBytes(sizeBytes)}{truncated ? " (truncated)" : ""}</dd>
                              {/if}
                            </dl>

                          {:else if name === "write_file"}
                            {@const path = typeof inp.path === "string" ? inp.path : ""}
                            {@const bytesWritten = typeof out.bytes_written === "number" ? out.bytes_written : null}
                            {@const contentLen = typeof inp.content === "string" ? inp.content.length : 0}
                            <div class="call-headline mono-sm">{path}</div>
                            <dl class="call-meta">
                              <dt>Status</dt>
                              <dd>{@render callStatus(call.state)}</dd>
                              {#if bytesWritten !== null}
                                <dt>Written</dt>
                                <dd>{formatBytes(bytesWritten)}</dd>
                              {:else if contentLen > 0}
                                <dt>Input</dt>
                                <dd>{formatBytes(contentLen)}</dd>
                              {/if}
                            </dl>

                          {:else if name === "list_files"}
                            {@const path = typeof inp.path === "string" ? inp.path : "."}
                            {@const entries = Array.isArray(out.entries) ? out.entries : []}
                            {@const truncated = out.truncated === true}
                            <div class="call-headline mono-sm">{path}</div>
                            <dl class="call-meta">
                              <dt>Status</dt>
                              <dd>{@render callStatus(call.state)}</dd>
                              {#if entries.length > 0 || call.state === "output-available"}
                                <dt>Entries</dt>
                                <dd>{entries.length}{truncated ? " (truncated)" : ""}</dd>
                              {/if}
                            </dl>

                          {:else if name === "memory_save"}
                            {@const text = typeof inp.text === "string" ? inp.text : ""}
                            {@const memType = typeof inp.type === "string" ? inp.type : "general"}
                            <div class="call-headline">{text.length > 60 ? `${text.slice(0, 60)}…` : text}</div>
                            <dl class="call-meta">
                              <dt>Status</dt>
                              <dd>{@render callStatus(call.state)}</dd>
                              <dt>Type</dt>
                              <dd>{memType}</dd>
                            </dl>

                          {:else if name === "do_task"}
                            {@const intent = typeof inp.intent === "string" ? inp.intent : ""}
                            {@const sessionId = typeof out.sessionId === "string" ? out.sessionId : null}
                            {@const taskStatus = typeof out.status === "string" ? out.status : null}
                            <div class="call-headline">{intent.length > 80 ? `${intent.slice(0, 80)}…` : intent}</div>
                            <dl class="call-meta">
                              <dt>Status</dt>
                              <dd>{@render callStatus(call.state)}</dd>
                              {#if sessionId}
                                <dt>Session</dt>
                                <dd class="mono-sm">{sessionId.slice(0, 8)}</dd>
                              {/if}
                              {#if taskStatus}
                                <dt>Result</dt>
                                <dd>{taskStatus}</dd>
                              {/if}
                            </dl>

                          {:else if name === "artifacts_get"}
                            {@const artifactId = typeof inp.artifactId === "string" ? inp.artifactId : ""}
                            {@const revision = typeof inp.revision === "number" ? inp.revision : null}
                            <div class="call-headline mono-sm">{artifactId}{revision !== null ? ` @r${revision}` : ""}</div>
                            <dl class="call-meta">
                              <dt>Status</dt>
                              <dd>{@render callStatus(call.state)}</dd>
                            </dl>

                          {:else}
                            <!-- Generic fallback for job tools and unknown tools -->
                            {@const preview = genericPreview(inp)}
                            {#if preview}
                              <div class="call-headline">{preview}</div>
                            {/if}
                            <dl class="call-meta">
                              <dt>Status</dt>
                              <dd>{@render callStatus(call.state)}</dd>
                              {#if typeof out.sessionId === "string"}
                                <dt>Session</dt>
                                <dd class="mono-sm">{(out.sessionId as string).slice(0, 8)}</dd>
                              {/if}
                              {#if typeof out.status === "string"}
                                <dt>Result</dt>
                                <dd>{out.status}</dd>
                              {/if}
                            </dl>
                          {/if}

                          {#if errorMsg}
                            <div class="call-error">{errorMsg}</div>
                          {/if}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}

      {:else if activeTab === "timeline"}
        {#if timeline.length === 0}
          <div class="empty">No activity yet.</div>
        {:else}
          <div class="timeline-list">
            {#each timeline as entry, i (i)}
              <div class="timeline-entry" class:user={entry.type === "user"} class:tool={entry.type === "tool"} class:assistant={entry.type === "assistant"}>
                <span class="timeline-icon">
                  {#if entry.type === "user"}→
                  {:else if entry.type === "tool"}{stateIcon(entry.toolState ?? "")}
                  {:else}←
                  {/if}
                </span>
                <div class="timeline-content">
                  {#if entry.type === "tool"}
                    <span class="timeline-tool-name">{entry.toolName}</span>
                    <span class="timeline-detail">{entry.content}</span>
                  {:else}
                    <span class="timeline-detail">{entry.content}</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}

      {:else if activeTab === "waterfall"}
        {#if waterfallTurns.length === 0}
          <div class="empty">Send a message to see timing data.</div>
        {:else}
          <div class="waterfall">
            {#each waterfallTurns as turn, i (i)}
              <div class="waterfall-turn">
                <div class="waterfall-header">
                  <span class="waterfall-label">{turn.userText}</span>
                  <span class="waterfall-total" class:active={turn.isActive}>{formatMs(turn.totalMs)}</span>
                </div>
                <div class="waterfall-bars">
                  {#each turn.bars as bar, bi (bar.label + bi)}
                    <div
                      class="waterfall-bar"
                      class:done={bar.state === "output-available" || bar.state === "done"}
                      class:error={bar.state === "output-error" || bar.state === "output-denied"}
                      class:running={bar.state === "streaming" || (bar.state !== "output-available" && bar.state !== "output-error" && bar.state !== "output-denied" && bar.state !== "done")}
                      class:waiting={bar.type === "waiting"}
                      title="{bar.label}: {formatMs(bar.durationMs)}"
                    >
                      <div class="bar-fill" style="inline-size: {bar.widthPct}%;"></div>
                      <span class="bar-label">{bar.label}</span>
                      <span class="bar-time">{formatMs(bar.durationMs)}</span>
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}

      {:else if activeTab === "prompt"}
        {#if systemPromptContext}
          <div class="prompt-viewer">
            {#each systemPromptContext.systemMessages as msg, i (i)}
              <details class="prompt-section" open={i === 0}>
                <summary>Part {i + 1} ({msg.length.toLocaleString()} chars)</summary>
                <pre class="prompt-text">{msg}</pre>
              </details>
            {/each}
          </div>
        {:else}
          <div class="empty">System prompt not captured yet. Send a message first.</div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .inspector {
    background-color: var(--color-surface-2);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }

  .resize-handle {
    block-size: 100%;
    cursor: col-resize;
    inline-size: 4px;
    inset-block-start: 0;
    inset-inline-start: 0;
    position: absolute;
    z-index: 5;
  }

  .resize-handle::after {
    background-color: var(--color-border-1);
    block-size: 100%;
    content: "";
    inline-size: 1px;
    inset-inline-start: 0;
    position: absolute;
    transition: background-color 100ms ease, inline-size 100ms ease;
  }

  .resize-handle:hover::after,
  .resize-handle.active::after {
    background-color: var(--color-primary);
    inline-size: 2px;
  }

  .inspector-tabs {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-shrink: 0;
    gap: 0;
  }

  .tab {
    align-items: center;
    background: transparent;
    border: none;
    border-block-end: 2px solid transparent;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    display: flex;
    flex: 1;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    justify-content: center;
    padding: var(--size-2-5) var(--size-2);
    transition: color 100ms ease;
  }

  .tab:hover {
    color: var(--color-text);
  }

  .tab.active {
    border-block-end-color: var(--color-primary);
    color: var(--color-text);
  }

  .badge {
    background-color: color-mix(in srgb, var(--color-text), transparent 85%);
    border-radius: var(--radius-round);
    font-size: var(--font-size-0);
    min-inline-size: 18px;
    padding: 1px 5px;
    text-align: center;
  }

  .inspector-body {
    flex: 1;
    overflow-y: auto;
    padding: var(--size-3);
    scrollbar-width: thin;
  }

  .section {
    margin-block-end: var(--size-4);
  }

  .section h4 {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.06em;
    margin-block-end: var(--size-2);
    text-transform: uppercase;
  }

  .kv-list {
    display: grid;
    gap: var(--size-1) var(--size-3);
    grid-template-columns: auto 1fr;
  }

  .kv-list dt {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
  }

  .kv-list dd {
    font-size: var(--font-size-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mono {
    font-family: var(--font-family-mono, ui-monospace, monospace);
  }

  .status-dot {
    background-color: color-mix(in srgb, var(--color-text), transparent 60%);
    block-size: 6px;
    border-radius: 50%;
    display: inline-block;
    inline-size: 6px;
  }

  .status-dot.active {
    animation: pulse 1.5s ease-in-out infinite;
    background-color: var(--color-success);
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    padding: var(--size-4);
    text-align: center;
  }

  .sub-label {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-0);
    letter-spacing: 0.03em;
    margin-block: var(--size-2) var(--size-1);
    text-transform: uppercase;
  }

  .skill-list-compact {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .skill-row-compact {
    align-items: center;
    display: flex;
    font-size: var(--font-size-0);
    gap: var(--size-2);
    padding: 2px 0;
  }

  .skill-name-compact {
    flex-grow: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .skill-meta {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    flex-shrink: 0;
    font-size: var(--font-size-0);
  }

  .badge-system {
    background-color: color-mix(in srgb, var(--color-primary, #6272ff), transparent 80%);
    border-radius: var(--radius-1);
    color: var(--color-primary, #6272ff);
    flex-shrink: 0;
    font-size: 9px;
    font-weight: var(--font-weight-7);
    letter-spacing: 0.04em;
    padding: 1px 4px;
    text-transform: uppercase;
  }

  /* Tools tab */
  .tool-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .tool-entry {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
  }

  .tool-name {
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .tool-stats {
    display: flex;
    gap: var(--size-1);
  }

  .stat {
    font-size: var(--font-size-0);
  }

  .stat.ok {
    color: var(--color-success);
  }

  .stat.err {
    color: var(--color-error);
  }

  .stat.running {
    color: var(--color-info);
  }

  .tool-group {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  /* Tool call detail rows */
  .tool-call-details {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    margin-inline-start: var(--size-2);
    padding-inline-start: var(--size-2);
    border-inline-start: 1px solid var(--color-border-1);
  }

  .call-detail {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .call-headline {
    color: var(--color-text);
    font-size: var(--font-size-0);
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .call-meta {
    display: grid;
    gap: 2px var(--size-3);
    grid-template-columns: auto 1fr;
  }

  .call-meta dt {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
  }

  .call-meta dd {
    font-size: var(--font-size-0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .call-error {
    color: var(--color-error);
    font-size: var(--font-size-0);
    line-height: 1.4;
    word-break: break-word;
  }

  .mono-sm {
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Badges */
  .http-badge, .search-badge, .lang-badge {
    border-radius: var(--radius-1);
    display: inline-block;
    font-size: 9px;
    font-weight: var(--font-weight-7);
    letter-spacing: 0.04em;
    margin-inline-end: var(--size-1);
    padding: 1px 4px;
    vertical-align: middle;
  }

  .http-badge {
    background-color: light-dark(hsl(142 50% 88%), hsl(142 20% 20%));
    color: light-dark(hsl(142 50% 30%), hsl(142 50% 70%));
  }

  .search-badge {
    background-color: light-dark(hsl(270 50% 90%), hsl(270 20% 20%));
    color: light-dark(hsl(270 50% 35%), hsl(270 50% 70%));
  }

  .lang-badge {
    background-color: light-dark(hsl(200 50% 90%), hsl(200 20% 20%));
    color: light-dark(hsl(200 50% 35%), hsl(200 50% 70%));
  }

  .lang-badge.python {
    background-color: light-dark(hsl(210 60% 90%), hsl(210 25% 20%));
    color: light-dark(hsl(210 60% 35%), hsl(210 60% 70%));
  }

  .lang-badge.javascript {
    background-color: light-dark(hsl(50 70% 90%), hsl(50 25% 18%));
    color: light-dark(hsl(50 70% 30%), hsl(50 70% 70%));
  }

  .lang-badge.bash {
    background-color: light-dark(hsl(0 0% 90%), hsl(0 0% 20%));
    color: light-dark(hsl(0 0% 35%), hsl(0 0% 70%));
  }

  .stat.dim {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
  }

  .stat.warn {
    color: light-dark(hsl(38 80% 40%), hsl(38 70% 65%));
  }

  /* Search results list */
  .search-results {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-block-start: var(--size-1);
  }

  .search-result {
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-0);
    gap: 0;
  }

  .search-result-title {
    color: var(--color-text);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-result-url {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Timeline tab */
  .timeline-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .timeline-entry {
    align-items: flex-start;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-2);
    padding: var(--size-1) 0;
  }

  .timeline-icon {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex-shrink: 0;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    inline-size: 14px;
    text-align: center;
  }

  .timeline-entry.user .timeline-icon {
    color: var(--color-primary);
  }

  .timeline-entry.tool .timeline-icon {
    color: var(--color-info);
  }

  .timeline-content {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .timeline-tool-name {
    color: var(--color-text);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-weight: var(--font-weight-5);
  }

  .timeline-detail {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    line-height: 1.4;
    word-break: break-word;
  }

  /* Prompt tab */
  .prompt-viewer {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .prompt-section > summary {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    user-select: none;
  }

  /* ─── Waterfall ──────────────────────────────────────────────────────── */

  .waterfall {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
  }

  .waterfall-turn {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .waterfall-header {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .waterfall-label {
    color: var(--color-text);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .waterfall-total {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    flex-shrink: 0;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0);
  }

  .waterfall-total.active {
    color: var(--color-info);
    font-weight: var(--font-weight-6);
  }

  .waterfall-bars {
    background-color: light-dark(hsl(220 12% 95%), color-mix(in srgb, var(--color-surface-3), transparent 50%));
    border-radius: var(--radius-1);
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-block-size: 24px;
    padding: 3px;
  }

  .waterfall-bar {
    align-items: center;
    border-radius: 3px;
    display: flex;
    font-size: var(--font-size-0);
    gap: var(--size-1);
    justify-content: space-between;
    overflow: hidden;
    padding: 3px 6px;
    position: relative;
  }

  .bar-fill {
    border-radius: 3px;
    inset: 0;
    min-inline-size: 2px;
    position: absolute;
    z-index: 0;
  }

  .bar-label, .bar-time {
    position: relative;
    z-index: 1;
  }

  .waterfall-bar.done {
    background-color: light-dark(hsl(142 60% 92%), hsl(142 20% 15%));
    color: light-dark(hsl(142 60% 25%), hsl(142 60% 80%));
  }

  .waterfall-bar.done .bar-fill {
    background-color: light-dark(hsl(142 60% 75%), hsl(142 40% 25%));
  }

  .waterfall-bar.running {
    background-color: light-dark(hsl(217 70% 93%), hsl(217 20% 15%));
    color: light-dark(hsl(217 70% 30%), hsl(217 70% 80%));
  }

  .waterfall-bar.running .bar-fill {
    animation: bar-pulse 1.5s ease-in-out infinite;
    background-color: light-dark(hsl(217 70% 78%), hsl(217 40% 30%));
  }

  .waterfall-bar.error {
    background-color: light-dark(hsl(10 70% 93%), hsl(10 20% 15%));
    color: light-dark(hsl(10 70% 30%), hsl(10 70% 80%));
  }

  .waterfall-bar.error .bar-fill {
    background-color: light-dark(hsl(10 70% 80%), hsl(10 40% 25%));
  }

  .waterfall-bar.waiting {
    background-color: light-dark(hsl(38 70% 93%), hsl(38 20% 15%));
    color: light-dark(hsl(38 70% 30%), hsl(38 70% 80%));
  }

  .waterfall-bar.waiting .bar-fill {
    animation: bar-pulse 1.5s ease-in-out infinite;
    background-color: light-dark(hsl(38 70% 78%), hsl(38 40% 25%));
  }

  @keyframes bar-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  .bar-label {
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bar-time {
    flex-shrink: 0;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    opacity: 0.7;
  }

  .prompt-text {
    background-color: light-dark(hsl(220 12% 97%), color-mix(in srgb, var(--color-surface-1), transparent 30%));
    border-radius: var(--radius-2);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0);
    line-height: 1.5;
    margin-block-start: var(--size-1);
    max-block-size: 400px;
    overflow: auto;
    padding: var(--size-2);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
