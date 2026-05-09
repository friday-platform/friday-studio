<!--
  Global usage page — `/usage`.

  Aggregates token + cache usage and USD cost across every chat the
  daemon has stored. Source of truth is the per-message `metadata.usage`
  the chat handler stamps on assistant turns. Aggregation is client-
  side: lists chats, fetches messages, sums per-model. MVP. If session
  counts grow large enough to make in-browser aggregation slow, the
  loop moves daemon-side.

  Pricing is loaded from a vendored snapshot of LiteLLM's
  `model_prices_and_context_window.json`; unknown models surface as
  "pricing unavailable" rather than displaying a misleading $0.
-->

<script lang="ts">
  import { onMount } from "svelte";
  import { tokensToCost } from "@atlas/llm/pricing";

  interface ChatSummary {
    id: string;
    title?: string;
    workspaceId?: string;
    updatedAt?: string;
  }

  interface UIMessage {
    role?: string;
    metadata?: {
      provider?: string;
      modelId?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
    };
  }

  interface PerChatRow {
    chatId: string;
    title: string;
    workspaceId?: string;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
    pricingResolved: boolean;
  }

  interface PerModelRow {
    modelId: string;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
    pricingResolved: boolean;
  }

  let chats = $state<ChatSummary[]>([]);
  let perChat = $state<PerChatRow[]>([]);
  let perModel = $state<PerModelRow[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let scannedChats = $state(0);
  let totalChats = $state(0);

  const totals = $derived.by(() => {
    let totalInputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let cost = 0;
    let turns = 0;
    let unresolvedTurns = 0;
    for (const row of perChat) {
      totalInputTokens += row.inputTokens;
      outputTokens += row.outputTokens;
      cacheReadTokens += row.cacheReadTokens;
      cacheWriteTokens += row.cacheWriteTokens;
      cost += row.cost;
      turns += row.turns;
      if (!row.pricingResolved) unresolvedTurns += row.turns;
    }
    // Fresh input is what was billed at the full rate. The cached
    // portion of `totalInputTokens` was billed at ~10% (Anthropic) or
    // ~50% (OpenAI) of the fresh rate; surfacing the total as the
    // top-line "Input tokens" overstates the cost share.
    const freshInputTokens = Math.max(0, totalInputTokens - cacheReadTokens);
    const cacheHitRatio =
      totalInputTokens > 0 && cacheReadTokens > 0
        ? cacheReadTokens / totalInputTokens
        : 0;
    return {
      totalInputTokens,
      freshInputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cost,
      turns,
      unresolvedTurns,
      cacheHitRatio,
    };
  });

  function fmtTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`;
    return `${(n / 1_000_000).toFixed(2)}M`;
  }

  function fmtCost(n: number): string {
    if (n === 0) return "$0";
    if (n < 0.01) return `<$0.01`;
    if (n < 1) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(2)}`;
  }

  async function loadAll(): Promise<void> {
    try {
      loading = true;
      error = null;

      const res = await fetch("/api/daemon/api/chat?limit=100");
      if (!res.ok) {
        throw new Error(`Failed to list chats: ${res.status}`);
      }
      const data = (await res.json()) as { chats?: ChatSummary[] };
      chats = data.chats ?? [];
      totalChats = chats.length;
      scannedChats = 0;

      const perChatRows: PerChatRow[] = [];
      const perModelMap = new Map<string, PerModelRow>();

      for (const chat of chats) {
        try {
          const wsPath = chat.workspaceId ?? "user";
          const msgsRes = await fetch(
            `/api/daemon/api/workspaces/${encodeURIComponent(wsPath)}/chat/${encodeURIComponent(chat.id)}`,
          );
          if (!msgsRes.ok) {
            scannedChats++;
            continue;
          }
          const msgsData = (await msgsRes.json()) as { messages?: UIMessage[] };
          const messages = msgsData.messages ?? [];

          let chatTurns = 0;
          let chatInput = 0;
          let chatOutput = 0;
          let chatCacheRead = 0;
          let chatCacheWrite = 0;
          let chatCost = 0;
          let chatPricingResolved = true;

          for (const msg of messages) {
            if (msg.role !== "assistant") continue;
            const usage = msg.metadata?.usage;
            const modelId = msg.metadata?.modelId;
            if (!usage || !modelId) continue;

            chatTurns++;
            const breakdown = tokensToCost(usage, modelId);
            chatInput += usage.inputTokens ?? 0;
            chatOutput += usage.outputTokens ?? 0;
            chatCacheRead += usage.cacheReadTokens ?? 0;
            chatCacheWrite += usage.cacheWriteTokens ?? 0;
            chatCost += breakdown.total;
            if (!breakdown.pricingResolved) chatPricingResolved = false;

            const existing = perModelMap.get(modelId) ?? {
              modelId,
              turns: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              cost: 0,
              pricingResolved: true,
            };
            existing.turns++;
            existing.inputTokens += usage.inputTokens ?? 0;
            existing.outputTokens += usage.outputTokens ?? 0;
            existing.cacheReadTokens += usage.cacheReadTokens ?? 0;
            existing.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
            existing.cost += breakdown.total;
            if (!breakdown.pricingResolved) existing.pricingResolved = false;
            perModelMap.set(modelId, existing);
          }

          if (chatTurns > 0) {
            perChatRows.push({
              chatId: chat.id,
              title: chat.title ?? "(untitled)",
              workspaceId: chat.workspaceId,
              turns: chatTurns,
              inputTokens: chatInput,
              outputTokens: chatOutput,
              cacheReadTokens: chatCacheRead,
              cacheWriteTokens: chatCacheWrite,
              cost: chatCost,
              pricingResolved: chatPricingResolved,
            });
          }
        } catch {
          // Per-chat fetch failures don't block the rest of the roll-up.
        } finally {
          scannedChats++;
        }
      }

      perChatRows.sort((a, b) => b.cost - a.cost);
      perChat = perChatRows;

      const modelRows = Array.from(perModelMap.values());
      modelRows.sort((a, b) => b.cost - a.cost);
      perModel = modelRows;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadAll();
  });
</script>

<div class="usage-page">
  <header>
    <h1>Usage</h1>
    <p class="subtitle">Token + cache + cost across every chat the daemon has stored.</p>
    <button onclick={() => void loadAll()} disabled={loading}>
      {loading ? "Loading…" : "Refresh"}
    </button>
  </header>

  {#if loading && perChat.length === 0}
    <div class="loading">
      Scanning {scannedChats} / {totalChats} chats…
    </div>
  {/if}

  {#if error}
    <div class="error">Failed to load: {error}</div>
  {/if}

  {#if !loading && perChat.length === 0 && !error}
    <div class="empty">
      No chats with recorded usage yet. Send a few messages, then refresh.
    </div>
  {/if}

  {#if perChat.length > 0}
    <section class="totals">
      <div class="big-stat">
        <div class="label">Total cost</div>
        <div class="value">{fmtCost(totals.cost)}</div>
        {#if totals.unresolvedTurns > 0}
          <div class="caveat">
            {totals.unresolvedTurns} turn{totals.unresolvedTurns === 1 ? "" : "s"} on
            models without pricing — actual cost is higher than shown.
          </div>
        {/if}
      </div>
      <div class="stat">
        <div class="label">Turns</div>
        <div class="value">{totals.turns.toLocaleString()}</div>
      </div>
      <div class="stat">
        <div class="label">Fresh input</div>
        <div class="value">{fmtTokens(totals.freshInputTokens)}</div>
        <div class="caveat">
          {fmtTokens(totals.totalInputTokens)} total prompt incl. cache
        </div>
      </div>
      <div class="stat">
        <div class="label">Output tokens</div>
        <div class="value">{fmtTokens(totals.outputTokens)}</div>
      </div>
      <div class="stat">
        <div class="label">Cache hit ratio</div>
        <div class="value">{Math.round(totals.cacheHitRatio * 100)}%</div>
        <div class="caveat">
          {fmtTokens(totals.cacheReadTokens)} read / {fmtTokens(totals.cacheWriteTokens)} write
        </div>
      </div>
    </section>

    <section>
      <h2>By model</h2>
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th class="num">Turns</th>
            <th class="num">Fresh input</th>
            <th class="num">Output</th>
            <th class="num">Cache read</th>
            <th class="num">Cache write</th>
            <th class="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {#each perModel as row (row.modelId)}
            <tr>
              <td>{row.modelId}</td>
              <td class="num">{row.turns}</td>
              <td class="num">{fmtTokens(Math.max(0, row.inputTokens - row.cacheReadTokens))}</td>
              <td class="num">{fmtTokens(row.outputTokens)}</td>
              <td class="num">{fmtTokens(row.cacheReadTokens)}</td>
              <td class="num">{fmtTokens(row.cacheWriteTokens)}</td>
              <td class="num">
                {#if row.pricingResolved}
                  {fmtCost(row.cost)}
                {:else}
                  <span class="dim">no pricing</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>

    <section>
      <h2>By chat</h2>
      <table>
        <thead>
          <tr>
            <th>Chat</th>
            <th>Workspace</th>
            <th class="num">Turns</th>
            <th class="num">Fresh input</th>
            <th class="num">Output</th>
            <th class="num">Cache read</th>
            <th class="num">Cost</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each perChat as row (row.chatId)}
            <tr>
              <td class="chat-title">{row.title}</td>
              <td><span class="dim">{row.workspaceId ?? "—"}</span></td>
              <td class="num">{row.turns}</td>
              <td class="num">{fmtTokens(Math.max(0, row.inputTokens - row.cacheReadTokens))}</td>
              <td class="num">{fmtTokens(row.outputTokens)}</td>
              <td class="num">{fmtTokens(row.cacheReadTokens)}</td>
              <td class="num">
                {#if row.pricingResolved}
                  {fmtCost(row.cost)}
                {:else}
                  <span class="dim">—</span>
                {/if}
              </td>
              <td>
                <a href="/platform/{row.workspaceId ?? 'user'}/chat/{row.chatId}">open →</a>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
</div>

<style>
  .usage-page {
    color: var(--text);
    inline-size: 100%;
    margin-inline: auto;
    max-inline-size: 1200px;
    padding: 1.5rem;
  }
  header {
    align-items: baseline;
    display: flex;
    gap: 1rem;
    margin-block-end: 1.5rem;
  }
  header h1 {
    color: var(--text-bright);
    font-size: 1.5rem;
    margin: 0;
  }
  header .subtitle {
    color: var(--text-faded);
    flex: 1;
    font-size: 0.85rem;
    margin: 0;
  }
  header button {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    color: var(--text);
    cursor: pointer;
    padding-block: 0.4rem;
    padding-inline: 0.9rem;
  }
  header button:hover:not(:disabled) {
    background: var(--highlight);
  }
  header button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .loading,
  .empty {
    color: var(--text-faded);
    padding-block: 1rem;
  }
  .error {
    color: var(--red-primary);
    padding-block: 1rem;
  }
  .totals {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    margin-block-end: 2rem;
  }
  .big-stat,
  .stat {
    background: var(--surface-bright);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding-block: 0.75rem;
    padding-inline: 1rem;
  }
  .big-stat {
    grid-column: span 2;
  }
  .label {
    color: var(--text-faded);
    font-size: 0.7rem;
    letter-spacing: 0.05em;
    margin-block-end: 0.25rem;
    text-transform: uppercase;
  }
  .value {
    color: var(--text-bright);
    font-size: 1.5rem;
    font-variant-numeric: tabular-nums;
  }
  .big-stat .value {
    font-size: 2rem;
  }
  .caveat {
    color: var(--text-faded);
    font-size: 0.7rem;
    margin-block-start: 0.25rem;
  }
  section {
    margin-block-end: 2rem;
  }
  section h2 {
    color: var(--text-bright);
    font-size: 1rem;
    margin: 0 0 0.5rem 0;
  }
  table {
    border-collapse: collapse;
    inline-size: 100%;
  }
  thead {
    border-block-end: 1px solid var(--border);
  }
  th,
  td {
    font-size: 0.85rem;
    padding-block: 0.4rem;
    padding-inline: 0.6rem;
    text-align: start;
  }
  th {
    color: var(--text-faded);
    font-weight: 500;
  }
  th.num,
  td.num {
    font-variant-numeric: tabular-nums;
    text-align: end;
  }
  tbody tr {
    border-block-end: 1px solid var(--border);
  }
  tbody tr:hover {
    background: var(--highlight);
  }
  td a {
    color: var(--blue-primary);
    text-decoration: none;
  }
  td a:hover {
    text-decoration: underline;
  }
  .chat-title {
    max-inline-size: 24ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dim {
    color: var(--text-faded);
  }
</style>
