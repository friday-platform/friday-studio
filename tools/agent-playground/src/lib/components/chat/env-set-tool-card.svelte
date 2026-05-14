<script lang="ts">
  import type { Elicitation } from "@atlas/core/elicitations/model";
  import { Button, Icons } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import {
    elicitationQueries,
    useAnswerElicitation,
  } from "$lib/queries/elicitation-queries.ts";
  import { readElicitationIdFromToolOutput } from "./human-input-matcher.ts";
  import { isInProgress } from "./tool-call-utils.ts";
  import type { ToolCallDisplay } from "./types.ts";

  interface Props {
    call: ToolCallDisplay;
  }

  const { call }: Props = $props();

  /** Key-name heuristic — kept in sync with the env tools' shared.ts. */
  const SECRET_KEY_RE = /password|secret|token|key|credential/i;
  const isSecretKey = (key: string): boolean => SECRET_KEY_RE.test(key);

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
  }

  /** The proposed write: { scope, vars }. Authoritative source is the matched
   *  elicitation's pendingTool.args; falls back to the tool call input while
   *  the elicitation is still syncing. */
  function readProposal(
    source: unknown,
  ): { scope: string; vars: Record<string, string> } | null {
    if (!isRecord(source)) return null;
    const scope = typeof source.scope === "string" ? source.scope : "workspace";
    if (!isRecord(source.vars)) return null;
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(source.vars)) {
      if (typeof v === "string") vars[k] = v;
    }
    return Object.keys(vars).length > 0 ? { scope, vars } : null;
  }

  const routeWorkspaceId = $derived(page.params.workspaceId as string | undefined);
  const listQuery = createQuery(() => elicitationQueries.list(routeWorkspaceId ?? null));
  const elicitations = $derived<Elicitation[]>(listQuery.data ?? []);

  // `env_set` returns the elicitationId in its tool output, so matching is a
  // direct id lookup — no question-text heuristic, no "syncing" guesswork.
  const elicitationId = $derived(readElicitationIdFromToolOutput(call));
  const matched = $derived<Elicitation | null>(
    elicitationId ? (elicitations.find((e) => e.id === elicitationId) ?? null) : null,
  );

  // One armed refetch if the tool settled but the elicitation hasn't reached
  // the cache yet (it is created server-side before the tool returns, so this
  // is rare — a cold cache, not a race).
  let refetchedForCall = "";
  $effect(() => {
    if (matched || listQuery.isFetching || isInProgress(call.state)) return;
    if (!elicitationId || refetchedForCall === call.toolCallId) return;
    refetchedForCall = call.toolCallId;
    void listQuery.refetch();
  });

  const proposal = $derived(
    readProposal(matched?.pendingTool?.args) ?? readProposal(call.input),
  );
  const scope = $derived(proposal?.scope ?? "workspace");
  const entries = $derived(Object.entries(proposal?.vars ?? {}));
  const hasSecretLooking = $derived(entries.some(([k]) => isSecretKey(k)));

  const status = $derived<Elicitation["status"] | null>(matched?.status ?? null);
  const answerValue = $derived(matched?.answer?.value ?? null);
  const isPending = $derived(status === "pending");
  const applied = $derived(status === "answered" && answerValue === "confirm");

  // Reveal state for secret-looking values, keyed by env var name.
  let revealed = $state<Record<string, boolean>>({});

  const answerMutation = useAnswerElicitation();
  const inFlight = $derived(answerMutation.isPending);

  const activityHref = $derived.by(() => {
    const base = routeWorkspaceId
      ? resolve("/platform/[workspaceId]/activity", { workspaceId: routeWorkspaceId })
      : resolve("/activity", {});
    return matched?.id ? `${base}?elicitationId=${encodeURIComponent(matched.id)}` : base;
  });

  function answer(value: "confirm" | "deny"): void {
    if (!matched || !isPending || inFlight) return;
    answerMutation.mutate({ id: matched.id, value });
  }

  /** Status pill text — drives the one terminal-state line. */
  const statusLabel = $derived.by(() => {
    if (!status) return isInProgress(call.state) ? "preparing" : "waiting";
    if (status === "pending") return "pending";
    if (status === "answered") return answerValue === "confirm" ? "applied" : "denied";
    return status; // declined | expired
  });
</script>

<!--
  Stable DOM: while the tool call is still streaming we render a fixed-height
  placeholder and nothing else — the full card mounts once, after the call
  settles, in a single transition (no per-chunk height churn in the
  virtualized message list).
-->
<div class="env-set-card" class:pending={isPending}>
  <div class="card-header">
    <span class="eyebrow">Environment write</span>
    <span class="status" class:status-pending={statusLabel === "pending"}>{statusLabel}</span>
  </div>

  {#if isInProgress(call.state)}
    <p class="hint">Preparing environment write…</p>
  {:else if !proposal}
    <p class="hint">
      {matched ? "No variables in this request." : "Syncing with Activity…"}
    </p>
  {:else}
    <div class="scope-line">
      Set {entries.length} variable{entries.length === 1 ? "" : "s"} in
      <code>{scope === "global" ? "the global .env" : "this workspace's .env"}</code>
    </div>

    <div class="var-list">
      {#each entries as [key, value] (key)}
        {@const secret = isSecretKey(key)}
        <div class="var-row">
          <code class="var-key">{key}</code>
          {#if secret}
            <input
              class="var-value"
              type={revealed[key] ? "text" : "password"}
              value={value}
              readonly
            />
            <button
              type="button"
              class="reveal"
              aria-label={revealed[key] ? "Hide value" : "Show value"}
              onclick={() => {
                revealed = { ...revealed, [key]: !revealed[key] };
              }}
            >
              {#if revealed[key]}<Icons.Eye />{:else}<Icons.EyeClosed />{/if}
            </button>
          {:else}
            <code class="var-value plain">{value}</code>
          {/if}
        </div>
      {/each}
    </div>

    {#if hasSecretLooking}
      <p class="hint secret-hint">
        Some keys look credential-bearing. The workspace <code>.env</code> is for
        non-secret values — consider connecting an integration (Link) for real
        credentials.
      </p>
    {/if}

    {#if isPending}
      <div class="actions">
        <Button onclick={() => answer("confirm")} disabled={!matched || inFlight}>
          {answerMutation.isPending ? "Applying…" : "Confirm"}
        </Button>
        <Button variant="destructive" onclick={() => answer("deny")} disabled={!matched || inFlight}>
          Deny
        </Button>
        <Button href={activityHref} variant="none">Open Activity</Button>
      </div>
    {:else if status}
      <p class="hint terminal">
        {#if applied}
          Applied — {entries.length} variable{entries.length === 1 ? "" : "s"} written.
        {:else if status === "answered"}
          Denied — nothing was written.
        {:else if status === "declined"}
          Declined — nothing was written.
        {:else}
          Expired — nothing was written.
        {/if}
      </p>
    {:else}
      <p class="hint">Syncing with Activity…</p>
    {/if}

    {#if answerMutation.isError}
      <p class="error">Failed: {answerMutation.error?.message ?? "unknown"}</p>
    {/if}
  {/if}
</div>

<style>
  .env-set-card {
    background-color: color-mix(in srgb, var(--blue-primary), transparent 92%);
    border: 1px solid color-mix(in srgb, var(--blue-primary), transparent 60%);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .env-set-card.pending {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--blue-primary), transparent 75%);
  }

  .card-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .eyebrow {
    color: color-mix(in srgb, var(--text), transparent 35%);
    font-size: var(--font-size-0, 11px);
    font-weight: var(--font-weight-7);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .status {
    background-color: color-mix(in srgb, var(--text), transparent 88%);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--text), transparent 30%);
    font-size: var(--font-size-0, 11px);
    font-weight: var(--font-weight-6);
    padding: 1px var(--size-2);
  }

  .status-pending {
    background-color: color-mix(in srgb, var(--blue-primary), transparent 75%);
    color: color-mix(in srgb, var(--blue-primary), black 35%);
  }

  .scope-line {
    color: var(--text-bright);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    line-height: 1.35;
  }

  .scope-line code {
    font-weight: var(--font-weight-4);
  }

  .var-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .var-row {
    align-items: center;
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    display: flex;
    gap: var(--size-2);
    padding: var(--size-1-5) var(--size-2);
  }

  .var-key {
    color: var(--text-bright);
    flex-shrink: 0;
    font-size: var(--font-size-1);
  }

  .var-value {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-1);
    color: var(--text);
    flex: 1;
    font: inherit;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-1);
    min-inline-size: 0;
    padding: var(--size-1) var(--size-1-5);
  }

  .var-value.plain {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reveal {
    align-items: center;
    background: none;
    border: none;
    color: var(--text-faded);
    cursor: pointer;
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 16px;
    block-size: 16px;
    padding: 0;
  }

  .reveal :global(svg) {
    inline-size: 100%;
    block-size: 100%;
  }

  .actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  .hint,
  .error {
    font-size: var(--font-size-1);
    margin: 0;
  }

  .hint {
    color: color-mix(in srgb, var(--text), transparent 45%);
  }

  .hint code {
    font-size: var(--font-size-0, 11px);
  }

  .secret-hint {
    color: color-mix(in srgb, var(--yellow-primary), black 25%);
  }

  .terminal {
    color: var(--text);
  }

  .error {
    color: var(--red-primary);
  }
</style>
