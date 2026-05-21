<script lang="ts">
  import type { Elicitation } from "@atlas/core/elicitations/model";
  import { Button, Icons, Tooltip } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { elicitationQueries, useAnswerElicitation } from "$lib/queries/elicitation-queries.ts";
  import { workspaceQueries } from "$lib/queries/workspace-queries.ts";
  import {
    buildVarsOverride,
    hasMissingSecretValue,
    isSecretKey,
  } from "./env-set-tool-card.ts";
  import {
    findDeclaredVariableForKey,
    validateProposedValue,
    type VariableValidationResult,
  } from "./env-write-variable-awareness.ts";
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

  // Variable-awareness layers on top of the existing raw rendering. Only
  // applies when the write targets the workspace `.env` — the global `.env`
  // has no per-workspace declarations to consult.
  const configQuery = createQuery(() =>
    workspaceQueries.config(scope === "workspace" ? (routeWorkspaceId ?? null) : null),
  );
  const declarations = $derived(configQuery.data?.config?.variables);

  interface EnrichedEntry {
    key: string;
    value: string;
    secret: boolean;
    declaredName: string | null;
    displayName: string | null;
    description: string | undefined;
    validation: VariableValidationResult | null;
  }

  const enrichedEntries = $derived<EnrichedEntry[]>(
    entries.map(([key, value]) => {
      const match = findDeclaredVariableForKey(declarations, key);
      return {
        key,
        value,
        secret: isSecretKey(key),
        declaredName: match?.name ?? null,
        displayName: match?.declaration.display_name ?? null,
        description: match?.declaration.description,
        validation: match ? validateProposedValue(match.declaration, value) : null,
      };
    }),
  );

  const hasValidationFailure = $derived(
    enrichedEntries.some((e) => e.validation && !e.validation.ok),
  );

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
  const missingSecretValue = $derived(hasMissingSecretValue(entries, userValues));

  const answerMutation = useAnswerElicitation();
  const inFlight = $derived(answerMutation.isPending);

  function answer(value: "confirm" | "deny"): void {
    if (!matched || !isPending || inFlight) return;
    if (value === "confirm" && hasValidationFailure) return;
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

  /**
   * Pull the current value of a proposed key from the daemon's env endpoint
   * (which returns the real value — only the agent-facing `env_get` tool
   * masks). Used so an applied card shows what actually hit `.env` instead
   * of replaying the proposal after a page refresh — the user's override
   * lives only in component state, so without this round-trip the input
   * would silently lie about what was committed. The value travels:
   * card → daemon → `.env` → daemon → card, never touching the chat
   * message stream. Triggered eagerly on mount for non-secret keys (no
   * privacy reason to defer) and lazily on the reveal button for secret
   * keys (the eyeball click is the explicit "show me" gesture).
   */
  async function fetchAppliedValue(key: string): Promise<void> {
    if (!applied) return;
    // Playground proxies daemon calls through `/api/daemon/*` — the
    // SvelteKit catch-all strips that prefix and forwards to atlasd.
    const base =
      scope === "global"
        ? "/api/daemon/api/config/env"
        : routeWorkspaceId
          ? `/api/daemon/api/workspaces/${encodeURIComponent(routeWorkspaceId)}/env`
          : null;
    if (!base) return;
    try {
      const res = await fetch(`${base}/${encodeURIComponent(key)}`);
      if (!res.ok) return;
      const body = (await res.json()) as { success?: boolean; value?: string };
      if (body.success && typeof body.value === "string") {
        userValues = { ...userValues, [key]: body.value };
      }
    } catch {
      // Silent — the input stays empty, user can click reveal again to retry.
    }
  }

  // Once an env-write lands as `applied`, eagerly fetch every non-secret
  // key's current disk value so the input reflects what's in `.env`, not
  // the stale proposal. Without this, a user-edited non-secret value
  // (e.g. LOG_DIR corrected from `/var/log` to `/srv/log`) shows the
  // agent's original after a refresh while disk holds the user's edit.
  // Secret keys stay lazy (reveal-button-driven) so the value isn't
  // pulled into memory until the user explicitly asks for it.
  // Plain Set, not `$state` — this is a side-effect dedup tracker, no
  // reactivity needed.
  const fetchedAppliedKeys = new Set<string>();
  $effect(() => {
    if (!applied) return;
    for (const [key] of entries) {
      if (isSecretKey(key)) continue;
      if (fetchedAppliedKeys.has(key)) continue;
      fetchedAppliedKeys.add(key);
      void fetchAppliedValue(key);
    }
  });

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
        Set {entries.length} {scope === "global" ? "global" : "workspace"} environment
        variable{entries.length === 1 ? "" : "s"}
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
      {#each enrichedEntries as entry (entry.key)}
        {@const maskApplied = !isPending && entry.secret && !revealed[entry.key]}
        <div class="var-group">
          {#if entry.displayName}
            <p class="var-display-name">{entry.displayName}</p>
          {/if}
          {#if entry.description}
            <p class="var-description">{entry.description}</p>
          {/if}
          <div class="var-row" class:invalid={entry.validation?.ok === false}>
            <code class="var-key">{entry.key}</code>
            <input
              class="var-value"
              type={entry.secret && !revealed[entry.key] ? "password" : "text"}
              value={maskApplied ? "********" : (userValues[entry.key] ?? entry.value)}
              placeholder="Enter value"
              autocomplete="off"
              spellcheck="false"
              disabled={!isPending || inFlight}
              oninput={(e) => {
                userValues = { ...userValues, [entry.key]: e.currentTarget.value };
              }}
            />
            {#if entry.secret}
              <button
                type="button"
                class="reveal"
                aria-label={revealed[entry.key] ? "Hide value" : "Show value"}
                onclick={() => {
                  const next = !revealed[entry.key];
                  revealed = { ...revealed, [entry.key]: next };
                  // On applied cards the in-memory value is gone after a
                  // page refresh; lazily fetch what's actually in .env so
                  // the eyeball click is the explicit "show me" gesture
                  // that triggers the read.
                  if (next && applied && !(userValues[entry.key] ?? "").length) {
                    void fetchAppliedValue(entry.key);
                  }
                }}
              >
                {#if revealed[entry.key]}<Icons.Eye />{:else}<Icons.EyeClosed />{/if}
              </button>
            {/if}
          </div>
          {#if entry.validation && !entry.validation.ok}
            <p class="validation-error" role="alert">
              Doesn't match the declared schema for
              <code>{entry.declaredName}</code>
              : {entry.validation.message}
            </p>
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
            variant="none"
            onclick={() => answer("deny")}
            disabled={!matched || inFlight}
          >
            Deny
          </Button>
          <Tooltip
            as="span"
            label={missingSecretValue
              ? "Fill in any blank values."
              : hasValidationFailure
                ? "Resolve schema validation errors above."
                : undefined}
          >
            <Button
              onclick={() => answer("confirm")}
              disabled={!matched || inFlight || missingSecretValue || hasValidationFailure}
            >
              {answerMutation.isPending ? "Applying…" : "Confirm"}
            </Button>
          </Tooltip>
        </div>
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
  /* Definitive width so the card renders identically regardless of
     what's beside it in the same message column. `min-inline-size`
     pushes the parent `.message.assistant` (now `width: fit-content`)
     to grow to at least the card's width, so a short sibling text
     bubble can't squeeze the card narrower. `align-self: flex-start`
     keeps the card from stretching when the parent ends up wider. */
  .env-set-card {
    align-self: flex-start;
    background-color: var(--surface-dark);
    border: 1px solid transparent;
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    inline-size: var(--size-128);
    margin-block-end: var(--size-4);
    min-inline-size: 0;
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

  /* Flex column of var-groups (description + row + validation). Each row
     owns its own grid template so the key/input/reveal columns are
     self-contained — the description prose above each row prevents
     cross-row subgrid alignment from being useful here. */
  .var-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    margin-block: var(--size-2);
  }

  .var-group {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .var-description {
    color: color-mix(in srgb, var(--text), transparent 25%);
    font-size: var(--font-size-1);
    line-height: 1.4;
    margin: 0;
  }

  /* Sans, body-size, slightly heavier than description so the friendly
     name reads as the primary affordance with the env key visible in
     the row below as the implementation detail. */
  .var-display-name {
    color: var(--text-bright);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    line-height: 1.35;
    margin: 0;
  }

  /* Single bordered envelope: key label slot, divider, input, optional
     reveal — all share one affordance. Focus is owned by the row via
     :focus-within so the border highlights as a unit. */
  .var-row {
    align-items: stretch;
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: grid;
    grid-template-columns: max-content 1fr auto;
    transition: border-color 150ms ease;
  }

  .var-row:focus-within {
    border-color: color-mix(in oklch, var(--color-text), transparent 60%);
  }

  .var-row.invalid {
    border-color: var(--red-primary);
  }

  .validation-error {
    color: var(--red-primary);
    font-size: var(--font-size-1);
    line-height: 1.35;
    margin: 0;
  }

  .validation-error code {
    font-size: var(--font-size-0, 11px);
  }

  .var-key {
    align-items: center;
    border-inline-end: 1px solid var(--color-border-1);
    color: var(--text-bright);
    display: inline-flex;
    flex-shrink: 0;
    font-size: var(--font-size-1);
    padding: var(--size-1-5) var(--size-2-5);
    transition: border-color 150ms ease;
  }

  .var-row:focus-within .var-key {
    border-inline-end-color: color-mix(in oklch, var(--color-text), transparent 60%);
  }

  /* Transparent input — the parent .var-row owns the border + fill, so
     the input dissolves into the envelope and only its text + caret read. */
  .var-value {
    background: transparent;
    border: none;
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    min-inline-size: 0;
    padding: var(--size-1-5) var(--size-2-5);
  }

  /* When the row has no reveal button (non-secret keys), let the input
     fill the trailing column so the row reads as `key | input` rather
     than `key | input | empty`. */
  .var-row:not(:has(.reveal)) .var-value {
    grid-column: 2 / -1;
  }

  .var-value:focus {
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
    padding: var(--size-1) var(--size-2);
  }

  .reveal:hover {
    color: var(--color-text);
  }

  .reveal :global(svg) {
    inline-size: 14px;
    block-size: 14px;
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
