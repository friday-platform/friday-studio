<!--
  Global usage page — `/usage`.

  Aggregates token + cache usage and USD cost across every chat the
  daemon has stored, fanned out across every visible workspace.
  Source of truth is the per-message `metadata.usage` the chat handler
  stamps on assistant turns. Aggregation is client-side: list
  workspaces → list each workspace's chats → fetch each chat's
  messages → sum per-model. MVP. If chat counts grow large enough
  to make in-browser aggregation slow, the loop moves daemon-side.

  Pricing is loaded from a vendored snapshot of LiteLLM's
  `model_prices_and_context_window.json`; unknown models surface as
  "pricing unavailable" rather than displaying a misleading $0.

  Filter UI mirrors `/activity`: status-style row of <select>s anchored
  to the page header.
-->

<script lang="ts">
  import { tokensToCost } from "@atlas/llm/pricing";
  import { PageLayout } from "@atlas/ui";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { workspaceQueries } from "$lib/queries";

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
    workspaceId: string;
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
    workspaceId: string;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
    pricingResolved: boolean;
  }

  let perChat = $state<PerChatRow[]>([]);
  let perModel = $state<PerModelRow[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let scannedChats = $state(0);
  let totalChats = $state(0);
  let workspaceFilter = $state<string>("all");

  const queryClient = useQueryClient();
  const workspacesQuery = createQuery(() => workspaceQueries.enriched());
  const workspaceOptions = $derived(workspacesQuery.data ?? []);

  // How many per-chat detail fetches to run in parallel inside `loadAll`.
  // The list-chats fan-out across workspaces (`Promise.all` at the top
  // of the rollup) already saturates the connection; per-chat fetches
  // then dominate page-load cost for users with many chats. A fixed-
  // width window keeps total wall-clock low without piling up enough
  // in-flight requests to torch the daemon's HTTP pool or starve
  // unrelated UI fetches that share the same browser connection limit.
  const CHAT_FETCH_CONCURRENCY = 8;

  // Display label for a workspace ID — `Name (id)`. Falls back to the
  // ID alone when no enriched record exists (e.g. legacy chats whose
  // workspace was deleted out from under us).
  function workspaceLabel(id: string): string {
    const ws = workspaceOptions.find((w) => w.id === id);
    return ws ? `${ws.displayName} (${ws.id})` : id;
  }

  // Filtered slice — applied AFTER aggregation so totals reflect the
  // selection. Empty filter (`all`) is a pass-through.
  const filteredPerChat = $derived(
    workspaceFilter === "all"
      ? perChat
      : perChat.filter((r) => r.workspaceId === workspaceFilter),
  );
  const filteredPerModel = $derived(
    workspaceFilter === "all"
      ? perModel
      : perModel.filter((r) => r.workspaceId === workspaceFilter),
  );

  const totals = $derived.by(() => {
    let totalInputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let cost = 0;
    let turns = 0;
    let unresolvedTurns = 0;
    for (const row of filteredPerChat) {
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
      totalInputTokens > 0 && cacheReadTokens > 0 ? cacheReadTokens / totalInputTokens : 0;
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

  // Aggregated re-sort of the model totals to reflect the selection.
  // Per-workspace rows for the same model collapse into one when
  // viewing "all"; with a filter, only the selected workspace's slice
  // remains and the modelId is unique by construction.
  const visibleModelRows = $derived.by(() => {
    if (workspaceFilter !== "all") return [...filteredPerModel].sort((a, b) => b.cost - a.cost);
    const collapsed = new Map<string, PerModelRow>();
    for (const row of filteredPerModel) {
      const existing = collapsed.get(row.modelId);
      if (!existing) {
        collapsed.set(row.modelId, { ...row, workspaceId: "all" });
      } else {
        existing.turns += row.turns;
        existing.inputTokens += row.inputTokens;
        existing.outputTokens += row.outputTokens;
        existing.cacheReadTokens += row.cacheReadTokens;
        existing.cacheWriteTokens += row.cacheWriteTokens;
        existing.cost += row.cost;
        if (!row.pricingResolved) existing.pricingResolved = false;
      }
    }
    return Array.from(collapsed.values()).sort((a, b) => b.cost - a.cost);
  });

  const visibleChatRows = $derived([...filteredPerChat].sort((a, b) => b.cost - a.cost));

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

  async function fetchChatsForWorkspace(wsId: string): Promise<ChatSummary[]> {
    const res = await fetch(
      `/api/daemon/api/workspaces/${encodeURIComponent(wsId)}/chat?limit=100`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { chats?: ChatSummary[] };
    return (data.chats ?? []).map((c) => ({ ...c, workspaceId: c.workspaceId ?? wsId }));
  }

  // Fetch a single chat's message bundle, walk its assistant turns,
  // and return both a per-chat row (or null if the chat has no
  // assistant turns) and a list of `(modelId, perModelDelta)` pairs the
  // caller folds into the rollup map. Pure-ish — does NOT mutate
  // module state, so it's safe to run in parallel batches and merge
  // deterministically.
  async function summarizeChat(
    chat: ChatSummary,
  ): Promise<{
    row: PerChatRow | null;
    modelDeltas: Array<{ modelId: string; workspaceId: string; usage: NonNullable<UIMessage["metadata"]>["usage"]; cost: number; pricingResolved: boolean }>;
  }> {
    const wsId = chat.workspaceId ?? "";
    if (!wsId) return { row: null, modelDeltas: [] };

    let messages: UIMessage[] = [];
    try {
      const msgsRes = await fetch(
        `/api/daemon/api/workspaces/${encodeURIComponent(wsId)}/chat/${encodeURIComponent(chat.id)}`,
      );
      if (!msgsRes.ok) return { row: null, modelDeltas: [] };
      const msgsData = (await msgsRes.json()) as { messages?: UIMessage[] };
      messages = msgsData.messages ?? [];
    } catch {
      // Per-chat fetch failures don't block the rest of the roll-up.
      return { row: null, modelDeltas: [] };
    }

    let chatTurns = 0;
    let chatInput = 0;
    let chatOutput = 0;
    let chatCacheRead = 0;
    let chatCacheWrite = 0;
    let chatCost = 0;
    let chatPricingResolved = true;
    const modelDeltas: Array<{
      modelId: string;
      workspaceId: string;
      usage: NonNullable<UIMessage["metadata"]>["usage"];
      cost: number;
      pricingResolved: boolean;
    }> = [];

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

      modelDeltas.push({
        modelId,
        workspaceId: wsId,
        usage,
        cost: breakdown.total,
        pricingResolved: breakdown.pricingResolved,
      });
    }

    if (chatTurns === 0) return { row: null, modelDeltas };

    return {
      row: {
        chatId: chat.id,
        title: chat.title ?? "(untitled)",
        workspaceId: wsId,
        turns: chatTurns,
        inputTokens: chatInput,
        outputTokens: chatOutput,
        cacheReadTokens: chatCacheRead,
        cacheWriteTokens: chatCacheWrite,
        cost: chatCost,
        pricingResolved: chatPricingResolved,
      },
      modelDeltas,
    };
  }

  async function loadAll(): Promise<void> {
    try {
      loading = true;
      error = null;
      perChat = [];
      perModel = [];
      scannedChats = 0;
      totalChats = 0;

      // Resolve the workspace list via the query client so the fan-out
      // sees every workspace at the moment loadAll runs — no need to
      // poll the reactive `workspacesQuery.isLoading` state. The
      // `enriched()` queryOptions are shared with the dropdown so this
      // hits the same cache and dedupes against an in-flight fetch.
      const workspaces = await queryClient.fetchQuery(workspaceQueries.enriched());
      const allWorkspaceIds = workspaces.map((w) => w.id);

      // Fan out chat-list fetches across workspaces. Per-workspace
      // failures don't block the rollup — a workspace that's been
      // deleted out from under us just contributes zero chats.
      const chatLists = await Promise.all(
        allWorkspaceIds.map((id) =>
          fetchChatsForWorkspace(id).catch(() => [] as ChatSummary[]),
        ),
      );

      const chats: ChatSummary[] = [];
      const seenIds = new Set<string>();
      for (const list of chatLists) {
        for (const chat of list) {
          if (seenIds.has(chat.id)) continue;
          seenIds.add(chat.id);
          chats.push(chat);
        }
      }
      totalChats = chats.length;

      const perChatRows: PerChatRow[] = [];
      const perModelMap = new Map<string, PerModelRow>();

      // Process chats in fixed-width parallel windows. Each window
      // resolves via `Promise.all`, then we fold its deltas into the
      // rollup before launching the next. This keeps total wall-clock
      // close to the slowest chat-fetch in each window (~1 RTT) without
      // exceeding `CHAT_FETCH_CONCURRENCY` in-flight requests.
      for (let i = 0; i < chats.length; i += CHAT_FETCH_CONCURRENCY) {
        const batch = chats.slice(i, i + CHAT_FETCH_CONCURRENCY);
        const summaries = await Promise.all(batch.map((c) => summarizeChat(c)));
        for (const summary of summaries) {
          if (summary.row) perChatRows.push(summary.row);
          for (const delta of summary.modelDeltas) {
            if (!delta.usage) continue;
            // Per-model rollup is keyed by `(workspaceId, modelId)` so
            // the per-workspace slice stays disjoint when filtering.
            // The "all" view re-collapses on `modelId` in
            // `visibleModelRows` so totals sum correctly.
            const modelKey = `${delta.workspaceId}:${delta.modelId}`;
            const existing = perModelMap.get(modelKey) ?? {
              modelId: delta.modelId,
              workspaceId: delta.workspaceId,
              turns: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              cost: 0,
              pricingResolved: true,
            };
            existing.turns++;
            existing.inputTokens += delta.usage.inputTokens ?? 0;
            existing.outputTokens += delta.usage.outputTokens ?? 0;
            existing.cacheReadTokens += delta.usage.cacheReadTokens ?? 0;
            existing.cacheWriteTokens += delta.usage.cacheWriteTokens ?? 0;
            existing.cost += delta.cost;
            if (!delta.pricingResolved) existing.pricingResolved = false;
            perModelMap.set(modelKey, existing);
          }
        }
        scannedChats += batch.length;
      }

      perChat = perChatRows;
      perModel = Array.from(perModelMap.values());
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void loadAll();
  });
</script>

<PageLayout.Root>
  <PageLayout.Title>Usage</PageLayout.Title>
  <PageLayout.Body>
    <PageLayout.Content>
      <div class="filters">
        <label class="filter">
          <span class="filter-label">Workspace</span>
          <select bind:value={workspaceFilter}>
            <option value="all">All workspaces</option>
            {#each workspaceOptions as ws (ws.id)}
              <option value={ws.id}>{ws.displayName} ({ws.id})</option>
            {/each}
          </select>
        </label>
        <button class="refresh" onclick={() => void loadAll()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        <span class="counts">
          {#if loading && perChat.length === 0}
            Scanning {scannedChats} / {totalChats} chats…
          {:else}
            {visibleChatRows.length} chat{visibleChatRows.length === 1 ? "" : "s"}
            · {totals.turns} turn{totals.turns === 1 ? "" : "s"}
          {/if}
        </span>
      </div>

      {#if error}
        <div class="error">Failed to load: {error}</div>
      {/if}

      {#if !loading && perChat.length === 0 && !error}
        <div class="empty">
          <p>No chats with recorded usage yet.</p>
          <span class="empty-hint">Send a few messages, then refresh.</span>
        </div>
      {/if}

      {#if !loading && perChat.length > 0 && filteredPerChat.length === 0 && !error}
        <div class="empty">
          <p>No chats with recorded usage in {workspaceLabel(workspaceFilter)}.</p>
          <span class="empty-hint">Pick a different workspace or "All workspaces".</span>
        </div>
      {/if}

      {#if filteredPerChat.length > 0}
        <section class="totals">
          <div class="big-stat">
            <div class="label">Total cost</div>
            <div class="value">{fmtCost(totals.cost)}</div>
            {#if totals.unresolvedTurns > 0}
              <div class="caveat">
                {totals.unresolvedTurns} turn{totals.unresolvedTurns === 1 ? "" : "s"} on models without
                pricing — actual cost is higher than shown.
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
              {#each visibleModelRows as row (`${row.workspaceId}:${row.modelId}`)}
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
              {#each visibleChatRows as row (row.chatId)}
                <tr>
                  <td class="chat-title">{row.title}</td>
                  <td><span class="dim">{workspaceLabel(row.workspaceId)}</span></td>
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
                    <a href="/platform/{row.workspaceId}/chat/{row.chatId}">open →</a>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
      {/if}
    </PageLayout.Content>
  </PageLayout.Body>
</PageLayout.Root>

<style>
  .filters {
    align-items: end;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-3);
    margin-block-end: var(--size-3);
    padding-block-end: var(--size-3);
  }

  .filter {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .filter-label {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .filter select {
    background-color: var(--surface, white);
    border: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font: inherit;
    min-inline-size: 14rem;
    padding: var(--size-1) var(--size-2);
  }

  .refresh {
    align-self: end;
    background: var(--surface, transparent);
    border: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font: inherit;
    padding: var(--size-1) var(--size-3);
  }
  .refresh:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-text), transparent 92%);
  }
  .refresh:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .counts {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-1);
    margin-inline-start: auto;
    padding-block-end: var(--size-1);
  }

  .empty {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-12) 0;
    text-align: center;
  }

  .empty-hint {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    max-inline-size: 36rem;
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
