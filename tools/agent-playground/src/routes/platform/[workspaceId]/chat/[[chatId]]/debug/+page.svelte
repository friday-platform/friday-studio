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
    let s: string;
    try {
      s = JSON.stringify(value, null, 2);
    } catch {
      s = String(value);
    }
    return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
  }

  function fullJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
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
              <div class="kv">
                <div class="kv-head">
                  <button type="button" onclick={() => toggle(dumpKey)}>
                    value {expanded[dumpKey] ? "▼" : "▶"}
                  </button>
                  {@render copyBtn(`copy:${dumpKey}`, fullJson(n.kv.value))}
                </div>
                <pre class="dump">{expanded[dumpKey] ? fullJson(n.kv.value) : shortJson(n.kv.value)}</pre>
              </div>
            {/if}
          </article>
        </div>
      {/if}
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
  .page {
    padding: var(--size-4);
    max-width: 1200px;
    margin: 0 auto;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-1, 13px);
  }
  h1 {
    margin: 0 0 var(--size-2);
    font-size: var(--font-size-3, 18px);
  }
  h2 {
    margin: var(--size-4) 0 var(--size-2);
    font-size: var(--font-size-2, 15px);
  }
  .meta,
  .links {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    margin-bottom: var(--size-1);
  }
  .links a {
    color: var(--color-link, #4a9eff);
  }
  .page-head {
    /* Stick to the top edge of the scroll container (Page.Content's
       `.scrollable` wrapper). The bar must be opaque so content
       scrolling underneath isn't visible through it; --color-surface-1
       adapts to dark/light mode. The previous negative top margin
       shoved the bar above the visible area when stuck — removed. */
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--color-surface-1);
    padding-block: var(--size-2);
    margin-block-end: var(--size-2);
    border-block-end: 1px solid color-mix(in srgb, var(--color-text), transparent 85%);
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: var(--size-2);
    flex-wrap: wrap;
  }
  .toolbar {
    margin-left: auto;
    display: flex;
    gap: var(--size-1);
    flex-wrap: wrap;
  }
  .toolbar > button {
    font: inherit;
    font-size: 0.92em;
    padding: 4px 10px;
    border: 1px solid color-mix(in srgb, var(--color-text), transparent 70%);
    border-radius: 3px;
    background: var(--color-background, #fff);
    color: var(--color-text);
    cursor: pointer;
  }
  .toolbar > button:hover:not(:disabled) {
    border-color: var(--color-link, #4a9eff);
    color: var(--color-link, #4a9eff);
  }
  .toolbar > button:disabled {
    opacity: 0.5;
    cursor: wait;
  }
  button.copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    cursor: pointer;
    margin-left: 4px;
    flex-shrink: 0;
    transition:
      color 100ms ease,
      border-color 100ms ease;
  }
  button.copy:hover {
    color: var(--color-link, #4a9eff);
    border-color: color-mix(in srgb, var(--color-link, #4a9eff), transparent 70%);
  }
  button.copy.done {
    color: var(--color-success, #29a36a);
  }
  button.copy svg {
    display: block;
  }
  .kv-head {
    display: flex;
    align-items: center;
    gap: var(--size-1);
    flex-wrap: wrap;
  }
  .kv-label {
    font-size: 0.92em;
    color: color-mix(in srgb, var(--color-text), transparent 35%);
  }
  article {
    border: 1px solid color-mix(in srgb, var(--color-text), transparent 80%);
    border-radius: 4px;
    padding: var(--size-2);
    margin-bottom: var(--size-2);
  }
  .message.assistant {
    background: color-mix(in srgb, var(--color-link, #4a9eff), transparent 95%);
  }
  .message.user {
    background: color-mix(in srgb, var(--color-text), transparent 95%);
  }
  article > header {
    display: flex;
    gap: var(--size-2);
    align-items: baseline;
    margin-bottom: var(--size-1);
    flex-wrap: wrap;
  }
  .role {
    font-weight: bold;
  }
  .ts,
  .msgid {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: 0.92em;
  }
  .metadata pre {
    font-size: 0.85em;
  }
  .part {
    border-left: 2px solid color-mix(in srgb, var(--color-text), transparent 80%);
    padding: var(--size-1) var(--size-2);
    margin-top: var(--size-1);
  }
  .part.tool {
    border-left-color: var(--color-link, #4a9eff);
  }
  .part.error {
    border-left-color: var(--color-error, #e44);
  }
  .part-head {
    display: flex;
    gap: var(--size-2);
    flex-wrap: wrap;
    align-items: baseline;
  }
  .kind {
    font-weight: bold;
  }
  .state {
    background: color-mix(in srgb, var(--color-text), transparent 90%);
    padding: 0 0.4em;
    border-radius: 3px;
  }
  .err {
    color: var(--color-error, #e44);
  }
  .session-link {
    color: var(--color-link, #4a9eff);
    margin-left: auto;
  }
  pre.text {
    white-space: pre-wrap;
    word-break: break-word;
    margin: var(--size-1) 0 0;
    font-size: 0.95em;
  }
  pre.dump {
    background: color-mix(in srgb, var(--color-text), transparent 92%);
    padding: var(--size-1);
    border-radius: 3px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.85em;
    margin: 4px 0;
    max-height: 600px;
    overflow-y: auto;
  }
  .kv button {
    font: inherit;
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    cursor: pointer;
    padding: 0;
    margin-top: 4px;
  }
  .kv button:hover {
    color: var(--color-text);
  }
  details {
    margin-top: var(--size-1);
  }
  summary {
    cursor: pointer;
  }
  .steps {
    margin: var(--size-1) 0;
    padding-left: var(--size-3);
  }
  .steps li {
    margin-bottom: var(--size-1);
  }
  .tools {
    list-style: none;
    padding: 0;
    margin: 4px 0 0;
  }
  .tools li {
    margin: 4px 0;
  }
  .empty {
    padding: var(--size-3);
    text-align: center;
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-style: italic;
  }
  .nats-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--size-2);
  }
  .nats-card h3 {
    margin: 0;
    font-size: var(--font-size-2, 14px);
  }
  .nats-card dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px var(--size-2);
    margin: var(--size-1) 0 0;
  }
  .nats-card dt {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
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
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-style: italic;
  }
  .job {
    color: var(--color-link, #4a9eff);
  }
</style>
