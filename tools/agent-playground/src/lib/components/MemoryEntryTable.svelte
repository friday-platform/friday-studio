<script lang="ts">
  import type { NarrativeEntry } from "$lib/api/memory.ts";
  import { parseEntryMeta } from "$lib/api/memory.ts";

  const {
    entries,
    loading = false,
  }: { entries: NarrativeEntry[]; loading?: boolean } = $props();

  let filterText = $state("");

  // Backlog-style fields get dedicated columns when ANY entry carries them.
  // Other metadata keys collapse into a generic Metadata column (so the
  // dispatch-log memory, the future improvements memory, etc. all render
  // useful columns instead of looking blank).
  const TYPED_KEYS = new Set([
    "status",
    "priority",
    "kind",
    "blocked_by",
    "payload",
  ]);

  const hasTypedColumns = $derived.by(() =>
    entries.some((e) => {
      const m = e.metadata;
      if (!m) return false;
      return "status" in m || "priority" in m || "kind" in m || "blocked_by" in m;
    }),
  );

  const otherKeys = $derived.by(() => {
    const keys = new Set<string>();
    for (const e of entries) {
      if (!e.metadata) continue;
      for (const k of Object.keys(e.metadata)) {
        if (!TYPED_KEYS.has(k)) keys.add(k);
      }
    }
    // Stable display order — alphabetical with task_id and session_id pinned first.
    const sorted = [...keys].sort();
    const pinned = ["task_id", "session_id", "target_workspace_id", "target_signal_id"];
    return [...pinned.filter((k) => keys.has(k)), ...sorted.filter((k) => !pinned.includes(k))];
  });

  const filtered = $derived.by(() => {
    const q = filterText.toLowerCase().trim();
    if (!q) return entries;
    return entries.filter((e) => {
      const meta = parseEntryMeta(e);
      return (
        e.id.toLowerCase().includes(q) ||
        e.text.toLowerCase().includes(q) ||
        (meta.status ?? "").toLowerCase().includes(q) ||
        (meta.kind ?? "").toLowerCase().includes(q)
      );
    });
  });

  function statusClass(status: string | undefined): string {
    if (status === "completed") return "row-completed";
    if (status === "blocked") return "row-blocked";
    return "";
  }

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function metaValue(entry: NarrativeEntry, key: string): string {
    const m = entry.metadata;
    if (!m || !(key in m)) return "";
    const v = m[key];
    if (v === null || v === undefined) return "";
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      return String(v);
    }
    return JSON.stringify(v);
  }

  function shorten(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
  }
</script>

<div class="table-wrapper">
  <div class="toolbar">
    <input
      class="filter-input"
      type="text"
      placeholder="Filter by id, title, status, kind…"
      bind:value={filterText}
    />
    <span class="entry-count">{filtered.length} entries</span>
  </div>

  {#if loading && entries.length === 0}
    <div class="empty-state">
      <span class="muted">Loading entries…</span>
    </div>
  {:else if filtered.length === 0 && !loading}
    <div class="empty-state">
      <span class="muted">
        {#if filterText}
          No entries match "{filterText}"
        {:else}
          No entries yet — the autopilot hasn't written here.
        {/if}
      </span>
    </div>
  {:else}
    <div class="scroll-area">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Title</th>
            {#if hasTypedColumns}
              <th>Status</th>
              <th>Priority</th>
              <th>Kind</th>
              <th>Blocked By</th>
            {/if}
            {#each otherKeys as key}
              <th>{key}</th>
            {/each}
            <th>Created</th>
            <th>Payload</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as entry, i (i + ":" + entry.id + ":" + entry.createdAt)}
            {@const meta = parseEntryMeta(entry)}
            <tr class={statusClass(meta.status)}>
              <td class="cell-id"><code>{entry.id}</code></td>
              <td class="cell-title">{entry.text}</td>
              {#if hasTypedColumns}
                <td>
                  {#if meta.status}
                    <span class="badge badge-{meta.status}">{meta.status}</span>
                  {/if}
                </td>
                <td>{meta.priority ?? ""}</td>
                <td>{meta.kind ?? ""}</td>
                <td>
                  {#if meta.blocked_by && meta.blocked_by.length > 0}
                    <div class="chips">
                      {#each meta.blocked_by as dep}
                        <span class="chip">{dep}</span>
                      {/each}
                    </div>
                  {/if}
                </td>
              {/if}
              {#each otherKeys as key}
                <td class="cell-meta"><code>{shorten(metaValue(entry, key), 40)}</code></td>
              {/each}
              <td class="cell-date">{formatDate(entry.createdAt)}</td>
              <td>
                {#if entry.metadata && Object.keys(entry.metadata).length > 0}
                  <details>
                    <summary class="payload-toggle">view</summary>
                    <pre class="payload-pre">{JSON.stringify(entry.metadata, null, 2)}</pre>
                  </details>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .table-wrapper {
    display: flex;
    flex-direction: column;
    min-block-size: 0;
    flex: 1;
  }

  .toolbar {
    align-items: center;
    display: flex;
    gap: var(--size-3);
    padding: var(--size-3) var(--size-4);
    border-block-end: 1px solid var(--color-border-1);
    flex-shrink: 0;
  }

  .filter-input {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    flex: 1;
    font-family: inherit;
    font-size: var(--font-size-2);
    max-inline-size: 360px;
    outline: none;
    padding: var(--size-1-5) var(--size-2);

    &::placeholder {
      color: color-mix(in srgb, var(--color-text), transparent 50%);
    }

    &:focus {
      border-color: var(--blue-2, #60a5fa);
    }
  }

  .entry-count {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    white-space: nowrap;
  }

  .scroll-area {
    flex: 1;
    min-block-size: 0;
    overflow: auto;
  }

  table {
    border-collapse: collapse;
    inline-size: 100%;
    font-size: var(--font-size-2);
  }

  thead {
    position: sticky;
    inset-block-start: 0;
    z-index: 1;
  }

  th {
    background: var(--color-surface-2);
    border-block-end: 1px solid var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    padding: var(--size-2) var(--size-3);
    text-align: start;
    text-transform: uppercase;
    white-space: nowrap;
  }

  td {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    padding: var(--size-2) var(--size-3);
    vertical-align: top;
  }

  tr.row-completed {
    background: color-mix(in srgb, var(--green-2, #4ade80), transparent 90%);
  }

  tr.row-completed td {
    color: var(--color-text);
  }

  tr.row-blocked {
    background: var(--color-surface-2);
  }

  tr.row-blocked td {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
  }

  .cell-id code {
    background: var(--color-surface-2);
    border-radius: var(--radius-1);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    padding: 1px var(--size-1);
  }

  .cell-title {
    max-inline-size: 360px;
  }

  .cell-date {
    font-size: var(--font-size-1);
    white-space: nowrap;
  }

  .cell-meta code {
    background: var(--color-surface-2);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    padding: 1px var(--size-1);
    white-space: nowrap;
  }

  .badge {
    border-radius: var(--radius-1);
    display: inline-block;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: 1px var(--size-1-5);
    text-transform: capitalize;
  }

  .badge-completed {
    background: color-mix(in srgb, var(--green-2, #4ade80), transparent 80%);
    color: var(--color-text);
  }

  .badge-blocked {
    background: color-mix(in srgb, var(--color-text), transparent 85%);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
  }

  .badge-pending {
    background: color-mix(in srgb, var(--yellow-2, #facc15), transparent 80%);
    color: var(--color-text);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
  }

  .chip {
    background: var(--color-surface-3);
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    padding: 1px var(--size-2);
    white-space: nowrap;
  }

  .payload-toggle {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-size: var(--font-size-1);
  }

  .payload-pre {
    background: var(--color-surface-2);
    border-radius: var(--radius-1);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    margin-block-start: var(--size-1);
    max-block-size: 200px;
    max-inline-size: 320px;
    overflow: auto;
    padding: var(--size-2);
  }

  .empty-state {
    align-items: center;
    display: flex;
    flex: 1;
    justify-content: center;
    min-block-size: 200px;
    padding: var(--size-10);
  }

  .muted {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
  }
</style>
