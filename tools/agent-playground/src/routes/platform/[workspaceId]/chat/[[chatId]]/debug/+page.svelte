<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }
  const { data }: Props = $props();

  function fmtTs(s: string | undefined): string {
    if (!s) return "";
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toISOString().replace("T", " ").replace("Z", "");
  }

  function partKind(p: Record<string, unknown>): string {
    return typeof p.type === "string" ? p.type : "unknown";
  }

  function isToolPart(p: Record<string, unknown>): boolean {
    return typeof p.type === "string" && p.type.startsWith("tool-");
  }

  function shortJson(value: unknown, max = 600): string {
    // JSON.stringify(undefined) returns undefined (not a string), which
    // crashes the render of error-state tool parts that never received an
    // `input` field. Coerce to "undefined" so callers always get a string.
    let s: string | undefined;
    try {
      s = JSON.stringify(value, null, 2);
    } catch {
      s = String(value);
    }
    if (s === undefined) return String(value);
    return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
  }

  function fullJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }

  function getSessionIdFromPart(p: Record<string, unknown>): string | null {
    const out = p.output as Record<string, unknown> | undefined;
    if (out && typeof out.sessionId === "string") return out.sessionId;
    return null;
  }

  let expanded = $state<Record<string, boolean>>({});
  function toggle(key: string) {
    expanded = { ...expanded, [key]: !expanded[key] };
  }

  // ── Toolbar actions ──────────────────────────────────────────────────────

  let refreshing = $state(false);
  async function refresh() {
    refreshing = true;
    try {
      await invalidateAll();
    } finally {
      refreshing = false;
    }
  }

  function download() {
    // Full server-load payload as one JSON blob — chat metadata, messages,
    // sub-sessions, and the JetStream/KV debug snapshot. The same shape the
    // page renders, so it's diffable with another download taken later.
    const payload = {
      exportedAt: new Date().toISOString(),
      workspaceId: data.workspaceId,
      chatId: data.chatId,
      chat: data.chat,
      messages: data.messages,
      sessions: data.sessions,
      nats: data.nats,
      fetchError: data.fetchError,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `chat-debug-${data.chatId}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ── Copy-to-clipboard ────────────────────────────────────────────────────
  // One `copied` map so each button shows a transient ✓ without clobbering
  // its neighbors. Keys are arbitrary strings — caller picks something
  // unique per field (e.g. `msg:${id}:input`).

  let copied = $state<Record<string, boolean>>({});
  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (e.g. http://, no permission). Fall back
      // to the legacy execCommand path so the button isn't dead in those
      // environments — degraded but functional.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // Give up silently — caller's copy button just won't show ✓.
        ta.remove();
        return;
      }
      ta.remove();
    }
    copied = { ...copied, [key]: true };
    setTimeout(() => {
      copied = { ...copied, [key]: false };
    }, 1200);
  }
</script>

<svelte:head>
  <title>chat debug · {data.chat?.id ?? data.chatId}</title>
</svelte:head>

{#snippet copyBtn(key: string, text: string)}
  <button
    type="button"
    class="copy"
    class:done={copied[key]}
    title={copied[key] ? "copied" : "copy to clipboard"}
    aria-label={copied[key] ? "copied" : "copy to clipboard"}
    onclick={(e) => {
      e.stopPropagation();
      copyText(key, text);
    }}
  >
    {#if copied[key]}
      <!-- check -->
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M3.5 8.5l3 3 6-7"
        />
      </svg>
    {:else}
      <!-- two-overlapping-rectangles "copy" glyph (Heroicons-style) -->
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <rect
          x="5.25"
          y="2.25"
          width="8.5"
          height="9.5"
          rx="1.25"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
        />
        <path
          d="M3.5 5.25v8a1.25 1.25 0 0 0 1.25 1.25h6.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>
    {/if}
  </button>
{/snippet}

<div class="page">
  <header class="page-head">
    <div class="title-row">
      <h1>chat debug</h1>
      <div class="toolbar">
        <button type="button" onclick={refresh} disabled={refreshing}>
          {refreshing ? "refreshing…" : "↻ refresh"}
        </button>
        <button type="button" onclick={download}>↓ download json</button>
        {@render copyBtn(
          "page:chat-id",
          data.chat?.id ?? data.chatId ?? "",
        )}
      </div>
    </div>
    <div class="meta">
      <code>{data.chat?.id ?? data.chatId}</code> · workspace <code>{data.workspaceId}</code>
      {#if data.chat}
        · {data.messages.length} messages
        · created {fmtTs(data.chat.createdAt)} · updated {fmtTs(data.chat.updatedAt)}
        {#if data.chat.title}
          · <em>{data.chat.title}</em>
        {/if}
      {/if}
    </div>
    <div class="links">
      <a href="/platform/{data.workspaceId}/chat/{data.chat?.id ?? data.chatId}">← back to chat</a>
    </div>
  </header>

  {#if data.fetchError}
    <section class="empty">
      <p>{data.fetchError}</p>
    </section>
  {/if}

  {#if data.nats}
    {@const n = data.nats as {
      stream?: {
        name: string;
        subject: string;
        exists: boolean;
        messages?: number;
        bytes?: number;
        firstSeq?: number;
        lastSeq?: number;
        created?: string;
        lastTs?: string;
        retention?: string;
        storage?: string;
        maxMsgSize?: number;
        replicas?: number;
        error?: string;
      };
      kv?: {
        bucket: string;
        key: string;
        exists: boolean;
        revision?: number;
        created?: string;
        operation?: string;
        length?: number;
        value?: unknown;
        error?: string;
      };
      activeStream?: {
        exists: boolean;
        active?: boolean;
        replayDisabled?: boolean;
        eventCount?: number;
        subscriberCount?: number;
        createdAt?: string;
        lastEventAt?: string;
        events?: unknown[];
        error?: string;
      };
      error?: string;
    }}
    <section>
      <h2>nats / jetstream</h2>
      {#if n.error}
        <p class="hint">debug fetch failed: {n.error}</p>
      {:else}
        <div class="nats-grid">
          <article class="nats-card">
            <header>
              <h3>stream</h3>
              <code class="state">{n.stream?.exists ? "exists" : "absent"}</code>
            </header>
            <dl>
              <dt>name</dt><dd><code>{n.stream?.name ?? "—"}</code></dd>
              <dt>subject</dt><dd><code>{n.stream?.subject ?? "—"}</code></dd>
              {#if n.stream?.exists}
                <dt>messages</dt><dd>{n.stream.messages ?? 0}</dd>
                <dt>bytes</dt><dd>{n.stream.bytes ?? 0}</dd>
                <dt>seq range</dt><dd>{n.stream.firstSeq ?? "—"} → {n.stream.lastSeq ?? "—"}</dd>
                <dt>created</dt><dd>{fmtTs(n.stream.created)}</dd>
                <dt>last ts</dt><dd>{fmtTs(n.stream.lastTs)}</dd>
                <dt>retention</dt><dd><code>{n.stream.retention}</code></dd>
                <dt>storage</dt><dd><code>{n.stream.storage}</code></dd>
                <dt>replicas</dt><dd>{n.stream.replicas}</dd>
                <dt>max msg</dt><dd>{n.stream.maxMsgSize}</dd>
              {/if}
              {#if n.stream?.error}
                <dt>error</dt><dd class="err">{n.stream.error}</dd>
              {/if}
            </dl>
          </article>

          <article class="nats-card">
            <header>
              <h3>kv</h3>
              <code class="state">{n.kv?.exists ? "exists" : "absent"}</code>
            </header>
            <dl>
              <dt>bucket</dt><dd><code>{n.kv?.bucket ?? "—"}</code></dd>
              <dt>key</dt><dd><code>{n.kv?.key ?? "—"}</code></dd>
              {#if n.kv?.exists}
                <dt>revision</dt><dd>{n.kv.revision}</dd>
                <dt>created</dt><dd>{fmtTs(n.kv.created)}</dd>
                <dt>operation</dt><dd><code>{n.kv.operation}</code></dd>
                <dt>length</dt><dd>{n.kv.length} bytes</dd>
              {/if}
              {#if n.kv?.error}
                <dt>error</dt><dd class="err">{n.kv.error}</dd>
              {/if}
            </dl>
            {#if n.kv?.exists && n.kv.value !== undefined}
              {@const dumpKey = "kv-value-dump"}
              {@const kvValueForDump =
                n.kv?.value && typeof n.kv.value === "object" && !Array.isArray(n.kv.value)
                  ? (() => {
                      // The full chat record includes
                      // `systemPromptContext`, which the dedicated
                      // "system prompt blocks" section above already
                      // renders with real line breaks. Showing it again
                      // here as JSON-escaped text invites the "why are
                      // these different" question — they aren't, it's
                      // the same bytes. Drop it from the dump to leave
                      // only the chat metadata + messages.
                      const { systemPromptContext: _stripped, ...rest } =
                        n.kv.value as Record<string, unknown>;
                      return rest;
                    })()
                  : n.kv?.value}
              <div class="kv">
                <div class="kv-head">
                  <button type="button" onclick={() => toggle(dumpKey)}>
                    value {expanded[dumpKey] ? "▼" : "▶"}
                  </button>
                  {@render copyBtn(`copy:${dumpKey}`, fullJson(kvValueForDump))}
                </div>
                <pre class="dump">{expanded[dumpKey] ? fullJson(kvValueForDump) : shortJson(kvValueForDump)}</pre>
              </div>
            {/if}
          </article>

          <article class="nats-card">
            <header>
              <h3>active stream</h3>
              <code class="state">{n.activeStream?.exists ? "exists" : "absent"}</code>
            </header>
            <dl>
              {#if n.activeStream?.exists}
                <dt>active</dt><dd>{String(n.activeStream.active)}</dd>
                <dt>events</dt><dd>{n.activeStream.eventCount ?? 0}</dd>
                <dt>subscribers</dt><dd>{n.activeStream.subscriberCount ?? 0}</dd>
                <dt>replay disabled</dt><dd>{String(n.activeStream.replayDisabled)}</dd>
                <dt>created</dt><dd>{fmtTs(n.activeStream.createdAt)}</dd>
                <dt>last event</dt><dd>{fmtTs(n.activeStream.lastEventAt)}</dd>
              {/if}
              {#if n.activeStream?.error}
                <dt>error</dt><dd class="err">{n.activeStream.error}</dd>
              {/if}
            </dl>
            {#if n.activeStream?.events}
              {@const streamDumpKey = "active-stream-events-dump"}
              <div class="kv">
                <div class="kv-head">
                  <button type="button" onclick={() => toggle(streamDumpKey)}>
                    events {expanded[streamDumpKey] ? "▼" : "▶"}
                  </button>
                  {@render copyBtn(`copy:${streamDumpKey}`, fullJson(n.activeStream.events))}
                </div>
                <pre class="dump">{expanded[streamDumpKey] ? fullJson(n.activeStream.events) : shortJson(n.activeStream.events)}</pre>
              </div>
            {/if}
          </article>
        </div>
      {/if}
    </section>
  {/if}

  {#if data.systemPromptContext && data.systemPromptContext.systemMessages.length > 0}
    {@const blocks = data.systemPromptContext.systemMessages}
    {@const hasBlock3 = blocks.length === 4}
    {@const blockLabels = [
      "Block 1 — weeks-stable (1h cache)",
      "Block 2 — workspace-stable (1h cache)",
      "Block 3 — session-stable (5m cache)",
      "Block 4 — volatile preface (uncached)",
    ]}
    <section>
      <h2>system prompt blocks</h2>
      <p class="hint">
        Captured {fmtTs(data.systemPromptContext.timestamp)} —
        {blocks.length} block{blocks.length === 1 ? "" : "s"} totaling
        {blocks.reduce((s, m) => s + m.length, 0).toLocaleString()} chars.
        Anthropic's `cache_control` markers sit on blocks 1, 2, and 3 (when
        present); block 4 is the volatile per-turn preface and is
        intentionally not cached. To force a fresh cache write next turn,
        edit any byte in block 1 or 2 (e.g. `prompt.txt` for block 1, the
        workspace YAML for block 2). Anthropic doesn't expose a
        clear-cache API — entries expire by their TTL (1h on block 1+2,
        5m on block 3) or by prefix-byte change.
      </p>
      <div class="block-grid">
        {#each blocks as content, bi (bi)}
          {@const isVolatile = bi === blocks.length - 1}
          {@const labelIndex = !hasBlock3 && bi === blocks.length - 1 ? 3 : bi}
          {@const blockKey = `block:${bi}`}
          <article class="block-card" class:volatile={isVolatile}>
            <header class="block-head">
              <span class="block-name">{blockLabels[labelIndex]}</span>
              <span class="block-stats">
                {content.length.toLocaleString()} chars
                · ~{Math.round(content.length / 4).toLocaleString()} tok
              </span>
              {@render copyBtn(`copy:${blockKey}`, content)}
            </header>
            <button type="button" class="block-toggle" onclick={() => toggle(blockKey)}>
              {expanded[blockKey] ? "▼ collapse" : "▶ expand"}
            </button>
            <pre class="block-body" class:block-body-collapsed={!expanded[blockKey]}>{content}</pre>
          </article>
        {/each}
      </div>
    </section>
  {/if}

  <section>
    <h2>messages</h2>
    {#each data.messages as m, i (m.id)}
      {@const ts =
        (m.metadata?.startTimestamp as string | undefined) ??
        (m.metadata?.timestamp as string | undefined)}
      <article class="message" class:assistant={m.role === "assistant"} class:user={m.role === "user"}>
        <header>
          <span class="role">[{i}] {m.role}</span>
          <span class="ts">{fmtTs(ts)}</span>
          <code class="msgid">{m.id}</code>
          {@render copyBtn(`msg:${m.id}:id`, m.id)}
          {@render copyBtn(`msg:${m.id}:full`, fullJson(m))}
        </header>

        {#if m.metadata && Object.keys(m.metadata).length > 0}
          <details class="metadata">
            <summary>
              metadata
              {@render copyBtn(`msg:${m.id}:metadata`, fullJson(m.metadata))}
            </summary>
            <pre>{fullJson(m.metadata)}</pre>
          </details>
        {/if}

        {#each m.parts as p, pi}
          {@const sid = getSessionIdFromPart(p)}
          <div class="part" class:tool={isToolPart(p)} class:error={p.state === "output-error"}>
            <div class="part-head">
              <code class="kind">{partKind(p)}</code>
              {#if p.state}<code class="state">{p.state}</code>{/if}
              {#if p.toolCallId}<code class="callid">{p.toolCallId}</code>{/if}
              {#if p.errorText}<span class="err">{p.errorText}</span>{/if}
              {#if sid}
                <a href="#session-{sid}" class="session-link">→ sub-session {sid.slice(0, 8)}</a>
              {/if}
              {@render copyBtn(`msg:${m.id}:part:${pi}`, fullJson(p))}
            </div>

            {#if p.type === "text"}
              <div class="kv">
                <div class="kv-head">
                  <span class="kv-label">text</span>
                  {@render copyBtn(`msg:${m.id}:part:${pi}:text`, String(p.text ?? ""))}
                </div>
                <pre class="text">{p.text}</pre>
              </div>
            {:else if isToolPart(p)}
              {@const inputKey = `${m.id}:${pi}:input`}
              {@const outputKey = `${m.id}:${pi}:output`}
              <div class="kv">
                <div class="kv-head">
                  <button type="button" onclick={() => toggle(inputKey)}>
                    input {expanded[inputKey] ? "▼" : "▶"}
                  </button>
                  {@render copyBtn(`copy:${inputKey}`, fullJson(p.input))}
                </div>
                <pre class="dump">{expanded[inputKey] ? fullJson(p.input) : shortJson(p.input)}</pre>
              </div>
              {#if p.output !== undefined}
                <div class="kv">
                  <div class="kv-head">
                    <button type="button" onclick={() => toggle(outputKey)}>
                      output {expanded[outputKey] ? "▼" : "▶"}
                    </button>
                    {@render copyBtn(`copy:${outputKey}`, fullJson(p.output))}
                  </div>
                  <pre class="dump">{expanded[outputKey] ? fullJson(p.output) : shortJson(p.output)}</pre>
                </div>
              {/if}
            {:else}
              {@const dumpKey = `${m.id}:${pi}:dump`}
              <div class="kv">
                <div class="kv-head">
                  <button type="button" onclick={() => toggle(dumpKey)}>
                    raw {expanded[dumpKey] ? "▼" : "▶"}
                  </button>
                  {@render copyBtn(`copy:${dumpKey}`, fullJson(p))}
                </div>
                <pre class="dump">{expanded[dumpKey] ? fullJson(p) : shortJson(p)}</pre>
              </div>
            {/if}
          </div>
        {/each}
      </article>
    {/each}
  </section>

  {#if Object.keys(data.sessions).length > 0}
    <section>
      <h2>sub-sessions</h2>
      <p class="hint">
        Sessions referenced from tool-call outputs above. Click "raw" to see the full SessionView
        (events, agent blocks, durations).
      </p>
      {#each Object.entries(data.sessions) as [sid, view]}
        <article class="session" id="session-{sid}">
          <header>
            <code>{sid}</code>
            {@render copyBtn(`session:${sid}:id`, sid)}
            {#if (view as any).error}
              <span class="err">unavailable: {(view as any).error}</span>
            {:else}
              {#if (view as any).jobName}<span class="job">{(view as any).jobName}</span>{/if}
              {#if (view as any).status}<code class="state">{(view as any).status}</code>{/if}
              {#if (view as any).durationMs}<span>{(view as any).durationMs}ms</span>{/if}
            {/if}
          </header>

          {#if !(view as any).error}
            {@const v = view as any}
            {#if v.agentBlocks?.length}
              <details>
                <summary>{v.agentBlocks.length} agent step{v.agentBlocks.length === 1 ? "" : "s"}</summary>
                <ol class="steps">
                  {#each v.agentBlocks as b, bi}
                    <li>
                      <header>
                        <strong>step {bi + 1}: {b.agentName ?? "?"}</strong>
                        {#if b.status}<code class="state">{b.status}</code>{/if}
                        {#if b.durationMs}<span>{b.durationMs}ms</span>{/if}
                        {@render copyBtn(`session:${sid}:step:${bi}`, fullJson(b))}
                      </header>
                      {#if b.toolCalls?.length}
                        <ul class="tools">
                          {#each b.toolCalls as tc, tci}
                            <li>
                              <div class="kv-head">
                                <code>{tc.toolName}</code>
                                {@render copyBtn(
                                  `session:${sid}:step:${bi}:tool:${tci}`,
                                  fullJson(tc.args),
                                )}
                              </div>
                              <pre class="dump">{shortJson(tc.args, 200)}</pre>
                            </li>
                          {/each}
                        </ul>
                      {/if}
                    </li>
                  {/each}
                </ol>
              </details>
            {/if}

            {@const dumpKey = `session:${sid}:dump`}
            <div class="kv">
              <div class="kv-head">
                <button type="button" onclick={() => toggle(dumpKey)}>
                  raw view {expanded[dumpKey] ? "▼" : "▶"}
                </button>
                {@render copyBtn(`copy:${dumpKey}`, fullJson(view))}
              </div>
              <pre class="dump">{expanded[dumpKey] ? fullJson(view) : shortJson(view)}</pre>
            </div>
          {/if}
        </article>
      {/each}
    </section>
  {/if}
</div>

<style>
  /* Style tokens come from `packages/ui/src/lib/colors.css` —
     `--surface`, `--surface-bright`, `--highlight`, `--border`,
     `--text`, `--text-bright`, `--text-faded`, plus the accent
     primaries (`--blue-primary`, `--green-primary`, `--red-primary`).
     They flip automatically on system light/dark preference. */

  .page {
    color: var(--text);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-1, 13px);
    margin-inline: auto;
    max-inline-size: 1200px;
    padding: var(--size-4);
  }
  h1 {
    color: var(--text-bright);
    font-size: var(--font-size-3, 18px);
    margin: 0 0 var(--size-2);
  }
  h2 {
    color: var(--text-bright);
    font-size: var(--font-size-2, 15px);
    margin: var(--size-4) 0 var(--size-2);
  }
  .meta,
  .links {
    color: var(--text-faded);
    margin-block-end: var(--size-1);
  }
  .links a {
    color: var(--blue-primary);
  }
  .page-head {
    background: var(--surface);
    border-block-end: 1px solid var(--border);
    margin-block-end: var(--size-2);
    padding-block: var(--size-2);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .title-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
    margin-inline-start: auto;
  }
  .toolbar > button {
    background: var(--surface-bright);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 0.92em;
    padding-block: 4px;
    padding-inline: 10px;
  }
  .toolbar > button:hover:not(:disabled) {
    background: var(--highlight);
    border-color: var(--border-bright);
    color: var(--text-bright);
  }
  .toolbar > button:disabled {
    cursor: wait;
    opacity: 0.5;
  }
  button.copy {
    align-items: center;
    background: transparent;
    block-size: 22px;
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--text-faded);
    cursor: pointer;
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 22px;
    justify-content: center;
    margin-inline-start: 4px;
    padding: 0;
    transition: color 100ms ease, border-color 100ms ease;
  }
  button.copy:hover {
    border-color: color-mix(in srgb, var(--blue-primary), transparent 70%);
    color: var(--blue-primary);
  }
  button.copy.done {
    color: var(--green-primary);
  }
  button.copy svg {
    display: block;
  }
  .kv-head {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
  }
  .kv-label {
    color: var(--text-faded);
    font-size: 0.92em;
  }
  article {
    background: var(--surface-bright);
    border: 1px solid var(--border);
    border-radius: 4px;
    margin-block-end: var(--size-2);
    padding: var(--size-2);
  }
  .message.assistant {
    background: color-mix(in srgb, var(--blue-primary), transparent 92%);
  }
  .message.user {
    background: var(--highlight);
  }
  article > header {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
    margin-block-end: var(--size-1);
  }
  .role {
    color: var(--text-bright);
    font-weight: bold;
  }
  .ts,
  .msgid {
    color: var(--text-faded);
    font-size: 0.92em;
  }
  .metadata pre {
    font-size: 0.85em;
  }
  .part {
    border-inline-start: 2px solid var(--border);
    margin-block-start: var(--size-1);
    padding-block: var(--size-1);
    padding-inline: var(--size-2);
  }
  .part.tool {
    border-inline-start-color: var(--blue-primary);
  }
  .part.error {
    border-inline-start-color: var(--red-primary);
  }
  .part-head {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }
  .kind {
    color: var(--text-bright);
    font-weight: bold;
  }
  .state {
    background: var(--highlight);
    border-radius: 3px;
    padding-inline: 0.4em;
  }
  .err {
    color: var(--red-primary);
  }
  .session-link {
    color: var(--blue-primary);
    margin-inline-start: auto;
  }
  pre.text {
    font-size: 0.95em;
    margin: var(--size-1) 0 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  pre.dump {
    background: var(--highlight);
    border-radius: 3px;
    color: var(--text);
    font-size: 0.85em;
    margin: 4px 0;
    max-block-size: 600px;
    overflow: auto;
    padding: var(--size-1);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .kv button {
    background: none;
    border: none;
    color: var(--text-faded);
    cursor: pointer;
    font: inherit;
    margin-block-start: 4px;
    padding: 0;
  }
  .kv button:hover {
    color: var(--text-bright);
  }
  details {
    margin-block-start: var(--size-1);
  }
  summary {
    cursor: pointer;
  }
  .steps {
    margin: var(--size-1) 0;
    padding-inline-start: var(--size-3);
  }
  .steps li {
    margin-block-end: var(--size-1);
  }
  .tools {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
  }
  .tools li {
    margin-block: 4px;
  }
  .empty {
    color: var(--text-faded);
    font-style: italic;
    padding: var(--size-3);
    text-align: center;
  }
  .nats-grid {
    display: grid;
    gap: var(--size-2);
    grid-template-columns: 1fr 1fr;
  }
  .nats-card h3 {
    color: var(--text-bright);
    font-size: var(--font-size-2, 14px);
    margin: 0;
  }
  .nats-card dl {
    display: grid;
    gap: 2px var(--size-2);
    grid-template-columns: max-content 1fr;
    margin: var(--size-1) 0 0;
  }
  .nats-card dt {
    color: var(--text-faded);
  }
  .nats-card dd {
    margin: 0;
    word-break: break-all;
  }
  @media (max-width: 800px) {
    .nats-grid {
      grid-template-columns: 1fr;
    }
  }
  .hint {
    color: var(--text-faded);
    font-style: italic;
  }
  .job {
    color: var(--blue-primary);
  }

  .block-grid {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    margin-block-start: var(--size-2);
  }

  .block-card {
    background: var(--surface-bright);
    border: 1px solid var(--border);
    border-radius: var(--radius-2, 0.5rem);
    padding: var(--size-3);
  }

  .block-card.volatile {
    border-style: dashed;
    opacity: 0.85;
  }

  .block-head {
    align-items: center;
    display: flex;
    gap: var(--size-3);
    margin-block-end: var(--size-2);
  }

  .block-name {
    color: var(--text-bright);
    font-weight: var(--font-weight-6);
  }

  .block-stats {
    color: var(--text-faded);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0);
  }

  .block-toggle {
    background: transparent;
    border: 0;
    color: var(--text-faded);
    cursor: pointer;
    font-size: var(--font-size-0);
    padding: 0;
    text-align: start;
  }

  .block-toggle:hover {
    color: var(--text-bright);
  }

  .block-body {
    background: var(--highlight);
    border-radius: var(--radius-1, 0.3rem);
    color: var(--text);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0);
    line-height: 1.4;
    margin-block-start: var(--size-1);
    overflow: auto;
    padding: var(--size-2);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Collapsed: bounded scroll window so the page doesn't blow up.
     Expanded: a generous viewport-relative cap so the full block is
     readable without dominating the screen. Either state is fully
     scrollable — content is never truncated. */
  .block-body {
    max-block-size: 70vh;
  }
  .block-body-collapsed {
    max-block-size: 12rem;
  }
</style>
