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
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let cost = 0;
    let turns = 0;
    let unresolvedTurns = 0;
    for (const row of perChat) {
      inputTokens += row.inputTokens;
      outputTokens += row.outputTokens;
      cacheReadTokens += row.cacheReadTokens;
      cacheWriteTokens += row.cacheWriteTokens;
      cost += row.cost;
      turns += row.turns;
      if (!row.pricingResolved) unresolvedTurns += row.turns;
    }
    const cacheHitRatio =
      inputTokens > 0 && cacheReadTokens > 0 ? cacheReadTokens / inputTokens : 0;
    return {
      inputTokens,
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
        <div class="label">Input tokens</div>
        <div class="value">{fmtTokens(totals.inputTokens)}</div>
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
            <th class="num">Input</th>
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
              <td class="num">{fmtTokens(row.inputTokens)}</td>
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
            <th class="num">Input</th>
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
              <td class="num">{fmtTokens(row.inputTokens)}</td>
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
    padding: 1.5rem;
    max-width: 1200px;
    margin: 0 auto;
    font-family: var(--font-system, system-ui);
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  header h1 {
    margin: 0;
    font-size: 1.5rem;
  }
  header .subtitle {
    margin: 0;
    flex: 1;
    color: var(--text-tertiary, #888);
    font-size: 0.85rem;
  }
  header button {
    padding: 0.4rem 0.9rem;
    border: 1px solid var(--border-default, #ccc);
    border-radius: 0.4rem;
    background: var(--surface-primary, #fff);
    cursor: pointer;
  }
  header button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .loading,
  .empty {
    color: var(--text-tertiary, #888);
    padding: 1rem 0;
  }
  .error {
    color: var(--danger-fg, #b00);
    padding: 1rem 0;
  }
  .totals {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 1rem;
    margin-bottom: 2rem;
  }
  .big-stat,
  .stat {
    padding: 0.75rem 1rem;
    border: 1px solid var(--border-subtle, #eee);
    border-radius: 0.5rem;
    background: var(--surface-primary, #fff);
  }
  .big-stat {
    grid-column: span 2;
  }
  .label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary, #888);
    margin-bottom: 0.25rem;
  }
  .value {
    font-size: 1.5rem;
    font-variant-numeric: tabular-nums;
  }
  .big-stat .value {
    font-size: 2rem;
  }
  .caveat {
    margin-top: 0.25rem;
    font-size: 0.7rem;
    color: var(--text-tertiary, #888);
  }
  section {
    margin-bottom: 2rem;
  }
  section h2 {
    font-size: 1rem;
    margin: 0 0 0.5rem 0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  thead {
    border-bottom: 1px solid var(--border-default, #ccc);
  }
  th,
  td {
    padding: 0.4rem 0.6rem;
    text-align: left;
    font-size: 0.85rem;
  }
  th.num,
  td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  tbody tr:nth-child(even) {
    background: var(--surface-secondary, #fafafa);
  }
  .chat-title {
    max-width: 24ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dim {
    color: var(--text-tertiary, #888);
  }
</style>
