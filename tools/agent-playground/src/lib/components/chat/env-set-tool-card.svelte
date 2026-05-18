<script lang="ts">
  import type { Elicitation } from "@atlas/core/elicitations/model";
  import { Button, Icons, Tooltip } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { elicitationQueries, useAnswerElicitation } from "$lib/queries/elicitation-queries.ts";
  import { buildVarsOverride } from "./env-set-tool-card.ts";
  import { readElicitationIdFromToolOutput } from "./human-input-matcher.ts";
  import { isInProgress } from "./tool-call-utils.ts";
  import type { ToolCallDisplay } from "./types.ts";

  interface Props {
    call: ToolCallDisplay;
    /**
     * Fired once after the user confirms the env write and the elicitation
     * answer mutation succeeds. Lets the parent chat send a synthetic
     * follow-up message so the agent continues without manual prompting.
     * Not fired on deny.
     */
    onApplied?: (info: { scope: "workspace" | "global"; keys: string[] }) => void;
  }

  const { call, onApplied }: Props = $props();

  /** Key-name heuristic — kept in sync with the env tools' shared.ts. */
  const SECRET_KEY_RE = /password|secret|token|key|credential/i;
  const isSecretKey = (key: string): boolean => SECRET_KEY_RE.test(key);

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
  }

  /** The proposed write: { scope, vars }. Authoritative source is the matched
   *  elicitation's pendingTool.args; falls back to the tool call input while
   *  the elicitation is still syncing. */
  function readProposal(source: unknown): { scope: string; vars: Record<string, string> } | null {
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

  const proposal = $derived(readProposal(matched?.pendingTool?.args) ?? readProposal(call.input));
  const scope = $derived(proposal?.scope ?? "workspace");
  const entries = $derived(Object.entries(proposal?.vars ?? {}));
  const hasSecretLooking = $derived(entries.some(([k]) => isSecretKey(k)));

  const status = $derived<Elicitation["status"] | null>(matched?.status ?? null);
  const answerValue = $derived(matched?.answer?.value ?? null);
  const isPending = $derived(status === "pending");
  const applied = $derived(status === "answered" && answerValue === "confirm");

  // Reveal state for secret-looking values, keyed by env var name.
  let revealed = $state<Record<string, boolean>>({});

  // User-typed values for every key in the proposal. The agent should
  // propose `""` for secret-bearing keys (see env_set tool description) so
  // the user types the real value here; non-secret keys come pre-filled
  // with the agent's literal value but stay editable so the user can fix
  // a typo or fill in a value the agent left blank without round-tripping
  // through chat. Either way, `varsOverride` carries the final committed
  // value so what the user sees in the card is what hits `.env`.
  // Note: component-state only. If the commit fails server-side and the
  // user refreshes, they retype any secret they entered — failure rate is
  // low enough that we accept the tradeoff over persisting plaintext to
  // sessionStorage.
  let userValues = $state<Record<string, string>>({});
  $effect(() => {
    for (const [key, value] of entries) {
      if (!(key in userValues)) {
        userValues = { ...userValues, [key]: value };
      }
    }
  });

  /** Confirm is blocked while any secret-looking key is empty (or whitespace-only). */
  const missingSecretValue = $derived(
    entries.some(([k]) => isSecretKey(k) && !(userValues[k] ?? "").trim().length),
  );

  const answerMutation = useAnswerElicitation();
  const inFlight = $derived(answerMutation.isPending);

  function answer(value: "confirm" | "deny"): void {
    if (!matched || !isPending || inFlight) return;
    if (value === "confirm" && missingSecretValue) return;
    // `varsOverride` carries the user's final value for every proposed
    // key — secret-bearing keys get the real value the user typed (kept
    // out of chat history because the agent proposed `""`), and non-
    // secret keys get whatever the user left or edited in the card.
    const varsOverride = buildVarsOverride(entries, userValues);
    const hasOverride = value === "confirm" && Object.keys(varsOverride).length > 0;
    answerMutation.mutate(
      hasOverride ? { id: matched.id, value, varsOverride } : { id: matched.id, value },
      {
        onSuccess: () => {
          // Tickle the chat only on confirm — deny shouldn't wake the agent.
          if (value !== "confirm") return;
          const normalizedScope = scope === "global" ? "global" : "workspace";
          onApplied?.({ scope: normalizedScope, keys: entries.map(([k]) => k) });
        },
      },
    );
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
    <h3 class="card-title">
      {#if isInProgress(call.state) || !proposal}
        Environment write
      {:else}
        Set {entries.length} variable{entries.length === 1 ? "" : "s"} in
        <code>{scope === "global" ? "global .env" : "workspace .env"}</code>
      {/if}
    </h3>
    <Tooltip
      as="span"
      label={statusLabel === "expired"
        ? "Confirmations expire after 30 minutes. Ask the agent to set this again."
        : undefined}
    >
      <span
        class="status"
        class:status-pending={statusLabel === "pending"}
        class:status-applied={statusLabel === "applied"}
        class:status-denied={statusLabel === "denied"}
      >
        {statusLabel}
      </span>
    </Tooltip>
  </div>

  {#if isInProgress(call.state)}
    <p class="hint">Preparing…</p>
  {:else if !proposal}
    <p class="hint">
      {matched ? "No variables in this request." : "Syncing with Activity…"}
    </p>
  {:else}
    <div class="var-list">
      {#each entries as [key, value] (key)}
        {@const secret = isSecretKey(key)}
        <div class="var-row">
          <code class="var-key">{key}</code>
          <input
            class="var-value"
            type={secret && !revealed[key] ? "password" : "text"}
            value={userValues[key] ?? value}
            placeholder="Enter value"
            autocomplete="off"
            spellcheck="false"
            disabled={!isPending || inFlight}
            oninput={(e) => {
              userValues = { ...userValues, [key]: e.currentTarget.value };
            }}
          />
          {#if secret}
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
          {/if}
        </div>
      {/each}
    </div>

    {#if isPending}
      <div class="actions">
        {#if hasSecretLooking}
          <p class="hint actions-hint">Credential-bearing values stay out of chat history.</p>
        {/if}
        <div class="actions-buttons">
          <Button
            variant="destructive"
            onclick={() => answer("deny")}
            disabled={!matched || inFlight}
          >
            Deny
          </Button>
          <Tooltip
            as="span"
            label={missingSecretValue
              ? "Enter a value for each secret-looking key to confirm."
              : undefined}
          >
            <Button
              onclick={() => answer("confirm")}
              disabled={!matched || inFlight || missingSecretValue}
            >
              {answerMutation.isPending ? "Applying…" : "Confirm"}
            </Button>
          </Tooltip>
        </div>
      </div>
    {:else if hasSecretLooking}
      <p class="hint">Credential-bearing values stay out of chat history.</p>
    {/if}

    {#if !isPending && status === "declined"}
      <p class="hint terminal">Declined — nothing was written.</p>
    {:else if !status}
      <p class="hint">Syncing with Activity…</p>
    {/if}

    {#if answerMutation.isError}
      <p class="error">Failed: {answerMutation.error?.message ?? "unknown"}</p>
    {/if}
  {/if}
</div>

<style>
  .env-set-card {
    background-color: var(--surface-dark);
    border: 1px solid transparent;
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    margin-block-end: var(--size-4);
    padding: var(--size-3);
  }

  /* Pending: a soft inset ring in --color-info — the codebase's
     "this element is active/selected" convention (pipeline-diagram,
     job-selector, model-chain). */
  .env-set-card.pending {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-info), transparent 50%);
  }

  .card-header {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
  }

  /* Single title slot — replaces the old monospace-uppercase eyebrow +
     separate scope line. Sentence-case sans-serif keeps the card on one
     typographic register; monospace only appears for the `.env` identifier
     inline below. */
  .card-title {
    color: var(--text-bright);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    line-height: 1.35;
    margin: 0;
  }

  /* Status badge — matches the project's .badge convention in
     MemoryEntryTable.svelte: small radius, sentence case, regular
     weight, no letter-spacing. */
  .status {
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    border-radius: var(--radius-1);
    color: var(--text-faded);
    display: inline-block;
    flex-shrink: 0;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: 1px var(--size-1-5);
    text-transform: capitalize;
  }

  .status-pending {
    background-color: color-mix(in srgb, var(--color-info), transparent 85%);
    color: var(--color-info);
  }

  .status-applied {
    background-color: color-mix(in srgb, var(--green-primary), transparent 85%);
    color: var(--green-primary);
  }

  .status-denied {
    background-color: color-mix(in srgb, var(--red-primary), transparent 85%);
    color: var(--red-primary);
  }

  .var-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  /* No background or border on the row itself — the input carries the
     only visible affordance; the row is pure layout. */
  .var-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .var-key {
    color: var(--text-bright);
    flex-shrink: 0;
    font-size: var(--font-size-1);
  }

  /* Input — matches signal-input-form.svelte: --color-surface-2 fill,
     --color-border-1 border, focus darkens the border to --color-text
     instead of the browser's blue ring. */
  .var-value {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    flex: 1;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    min-inline-size: 0;
    padding: var(--size-1) var(--size-2);
    transition: border-color 150ms ease;
  }

  .var-value:focus {
    border-color: color-mix(in oklch, var(--color-text), transparent 60%);
    outline: none;
  }

  .var-value::placeholder {
    color: color-mix(in oklch, var(--color-text), transparent 50%);
  }

  .reveal {
    align-items: center;
    background: none;
    border: none;
    color: var(--text-faded);
    cursor: pointer;
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 14px;
    block-size: 14px;
    padding: 0;
  }

  .reveal :global(svg) {
    inline-size: 100%;
    block-size: 100%;
  }

  /* Footer row: hint (left, muted) + buttons (right). The buttons use
     margin-inline-start: auto so they stay right-aligned whether or not
     the hint is present. */
  .actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  .actions-hint {
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  .actions-buttons {
    display: flex;
    gap: var(--size-1-5);
    margin-inline-start: auto;
  }

  .hint,
  .error {
    font-size: var(--font-size-1);
    margin: 0;
  }

  .hint {
    color: var(--text-faded);
  }

  .terminal {
    color: var(--text);
  }

  .error {
    color: var(--red-primary);
  }
</style>
