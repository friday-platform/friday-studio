<script lang="ts">
  import type { Elicitation, ElicitationStatus } from "@atlas/core/elicitations/model";
  import { Button } from "@atlas/ui";
  import { tick } from "svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { effectiveElicitationStatus } from "$lib/elicitation-counts.ts";
  import {
    buildGroupedOptionAnswer,
    buildNestedChoiceAnswer,
    formatChoiceComments,
    parseGroupedOptionPrompt,
    parseNestedChoicePrompt,
  } from "$lib/human-input/nested-choice.ts";
  import {
    elicitationQueries,
    useAnswerElicitation,
    useDeclineElicitation,
  } from "$lib/queries/elicitation-queries.ts";
  import {
    findMatchingHumanInputElicitation,
    readHumanInputRequest,
  } from "./human-input-matcher.ts";
  import type { ToolCallDisplay } from "./types.ts";

  interface Props {
    call: ToolCallDisplay;
  }

  let { call }: Props = $props();

  const routeWorkspaceId = $derived(page.params.workspaceId as string | undefined);
  const request = $derived(readHumanInputRequest(call));
  const listQuery = createQuery(() => elicitationQueries.list(routeWorkspaceId ?? null));
  const elicitations = $derived<Elicitation[]>(listQuery.data ?? []);
  const matched = $derived<Elicitation | null>(
    findMatchingHumanInputElicitation(call, elicitations, routeWorkspaceId),
  );

  // `nowMs` only exists so `effectiveStatus` can flip `pending → expired`
  // the moment the matched elicitation's deadline passes — there's no
  // countdown label on this card. A 1Hz `setInterval` writing
  // `nowMs = Date.now()` ran continuously regardless of whether any
  // elicitation was actually approaching its deadline, and the reactive
  // write cascaded through every chat-message render. Replace with a
  // one-shot `setTimeout` armed exactly at `matched.expiresAt`: zero
  // ticks while pending entries are far from expiry, one wakeup at the
  // boundary, then quiescence after the flip.
  let nowMs = $state(Date.now());
  $effect(() => {
    if (!matched || matched.status !== "pending") return;
    const expiresAt = new Date(matched.expiresAt).getTime();
    if (!Number.isFinite(expiresAt)) return;
    const delay = expiresAt - Date.now();
    if (delay <= 0) {
      nowMs = Date.now();
      return;
    }
    const id = setTimeout(() => {
      nowMs = Date.now();
    }, delay);
    return () => clearTimeout(id);
  });

  const effectiveStatus = $derived<ElicitationStatus | null>(
    matched ? effectiveElicitationStatus(matched, nowMs) : null,
  );
  const isPending = $derived(effectiveStatus === "pending");

  let selectedValue = $state("");
  let nestedChoices = $state<Record<string, string>>({});
  let choiceComments = $state<Record<string, string>>({});
  let freeText = $state("");
  let note = $state("");

  $effect(() => {
    matched?.id;
    request?.question;
    selectedValue = request?.options?.[0]?.value ?? "";
    nestedChoices = {};
    choiceComments = {};
    freeText = "";
    note = "";
  });

  const hasOptions = $derived((request?.options?.length ?? 0) > 0);
  const groupedOptionPrompt = $derived(
    request && hasOptions ? parseGroupedOptionPrompt(request.question, request.options) : null,
  );
  const nestedChoicePrompt = $derived(
    request && !hasOptions ? parseNestedChoicePrompt(request.question) : null,
  );
  const choicePrompt = $derived(groupedOptionPrompt ?? nestedChoicePrompt);
  const answerValue = $derived(
    groupedOptionPrompt
      ? buildGroupedOptionAnswer(nestedChoices)
      : hasOptions
        ? selectedValue
        : nestedChoicePrompt
          ? buildNestedChoiceAnswer(nestedChoices)
          : freeText.trim(),
  );

  const hasAnswerValue = $derived(
    groupedOptionPrompt
      ? Object.values(nestedChoices).some((value) => value.trim().length > 0)
      : answerValue.length > 0,
  );
  const answerMutation = useAnswerElicitation();
  const declineMutation = useDeclineElicitation();
  const inFlight = $derived(answerMutation.isPending || declineMutation.isPending);
  const canAnswer = $derived(Boolean(matched) && isPending && !inFlight && hasAnswerValue);
  const canDecline = $derived(Boolean(matched) && isPending && !inFlight);
  const controlsDisabled = $derived(inFlight);
  const formId = $derived(matched?.id ?? call.toolCallId);

  const activityHref = $derived.by(() => {
    const base = routeWorkspaceId
      ? resolve("/platform/[workspaceId]/activity", { workspaceId: routeWorkspaceId })
      : resolve("/activity", {});
    return matched?.id ? `${base}?elicitationId=${encodeURIComponent(matched.id)}` : base;
  });

  let lastRefetchedForCall = "";
  $effect(() => {
    if (!request || matched || listQuery.isFetching) return;
    if (lastRefetchedForCall === call.toolCallId) return;
    lastRefetchedForCall = call.toolCallId;
    void listQuery.refetch();
  });

  let actionsEl: HTMLDivElement | undefined = $state();
  let lastScrolledPendingId = "";
  $effect(() => {
    const id = matched?.id;
    if (!id || !isPending || id === lastScrolledPendingId) return;
    lastScrolledPendingId = id;
    void tick().then(() => {
      actionsEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  });

  function answerNote(): string {
    const parts: string[] = [];
    const baseNote = note.trim();
    if (baseNote.length > 0) parts.push(baseNote);
    const choiceCommentText = formatChoiceComments(choiceComments);
    if (choiceCommentText.length > 0) parts.push(`Choice comments:\n${choiceCommentText}`);
    return parts.join("\n\n");
  }

  function onAnswer() {
    if (!matched || !canAnswer) return;
    const finalNote = answerNote();
    answerMutation.mutate({
      id: matched.id,
      value: answerValue,
      ...(finalNote.length > 0 ? { note: finalNote } : {}),
    });
  }

  function onDecline() {
    if (!matched || !canDecline) return;
    declineMutation.mutate({
      id: matched.id,
      ...(note.trim().length > 0 ? { note: note.trim() } : {}),
    });
  }
</script>

<div class="human-input-card" class:pending={isPending}>
  <div class="card-header">
    <span class="eyebrow">Human input</span>
    {#if effectiveStatus}
      <span class="status" class:status-pending={effectiveStatus === "pending"}>
        {effectiveStatus}
      </span>
    {:else if call.state === "output-available"}
      <span class="status">completed</span>
    {:else}
      <span class="status status-pending">waiting</span>
    {/if}
  </div>

  <div class="question">
    {choicePrompt?.intro || request?.question || "Waiting for a decision from the user."}
  </div>

  {#if matched?.answer}
    <div class="answer-block">
      <span class="label">Answer</span>
      <code>{matched.answer.value}</code>
      {#if matched.answer.note}
        <p>{matched.answer.note}</p>
      {/if}
    </div>
  {:else if request && (!matched || isPending)}
    <div class="response-form">
      {#if groupedOptionPrompt}
        <div class="nested-choice-list" aria-label="Choose an action for each item">
          {#each groupedOptionPrompt.items as item (item.index)}
            <section class="nested-choice-item">
              <div class="nested-choice-copy">
                <strong>{item.index}. {item.title}</strong>
                {#if item.detail}
                  <span>{item.detail}</span>
                {/if}
              </div>
              <div class="nested-choice-controls">
                <div class="choice-buttons" role="radiogroup" aria-label={`Action for ${item.title}`}>
                  {#each item.actions as action (action.value)}
                    <label class="choice-button" class:active={nestedChoices[String(item.index)] === action.value}>
                      <input
                        type="radio"
                        name="human-input-{formId}-{item.index}"
                        value={action.value}
                        checked={nestedChoices[String(item.index)] === action.value}
                        disabled={controlsDisabled}
                        onchange={(event) => {
                          if (!event.currentTarget.checked) return;
                          nestedChoices = {
                            ...nestedChoices,
                            [String(item.index)]: action.value,
                          };
                        }}
                      />
                      <span>{action.label}</span>
                    </label>
                  {/each}
                </div>
                <input
                  class="choice-comment"
                  type="text"
                  value={choiceComments[String(item.index)] ?? ""}
                  disabled={controlsDisabled}
                  placeholder="Comment for this item…"
                  oninput={(event) => {
                    choiceComments = {
                      ...choiceComments,
                      [String(item.index)]: event.currentTarget.value,
                    };
                  }}
                />
              </div>
            </section>
          {/each}
          {#if groupedOptionPrompt.instructions}
            <p class="hint">{groupedOptionPrompt.instructions}</p>
          {/if}
        </div>
      {:else if hasOptions}
        <div class="options" role="radiogroup" aria-label={request.question}>
          {#each request.options ?? [] as opt (opt.value)}
            <label class="option" class:active={selectedValue === opt.value}>
              <input
                type="radio"
                name="human-input-{formId}"
                value={opt.value}
                bind:group={selectedValue}
                disabled={controlsDisabled}
              />
              <span>{opt.label}</span>
            </label>
          {/each}
        </div>
      {:else if nestedChoicePrompt}
        <div class="nested-choice-list" aria-label="Choose an action for each item">
          {#each nestedChoicePrompt.items as item (item.index)}
            <section class="nested-choice-item">
              <div class="nested-choice-copy">
                <strong>{item.index}. {item.title}</strong>
                {#if item.detail}
                  <span>{item.detail}</span>
                {/if}
              </div>
              <div class="nested-choice-controls">
                <select
                  disabled={controlsDisabled}
                  value={nestedChoices[String(item.index)] ?? ""}
                  onchange={(event) => {
                    nestedChoices = {
                      ...nestedChoices,
                      [String(item.index)]: event.currentTarget.value,
                    };
                  }}
                >
                  <option value="">Choose…</option>
                  {#each item.actions as action (action.value)}
                    <option value={action.value}>{action.label}</option>
                  {/each}
                </select>
                <input
                  class="choice-comment"
                  type="text"
                  value={choiceComments[String(item.index)] ?? ""}
                  disabled={controlsDisabled}
                  placeholder="Comment for this item…"
                  oninput={(event) => {
                    choiceComments = {
                      ...choiceComments,
                      [String(item.index)]: event.currentTarget.value,
                    };
                  }}
                />
              </div>
            </section>
          {/each}
          {#if nestedChoicePrompt.instructions}
            <p class="hint">{nestedChoicePrompt.instructions}</p>
          {/if}
        </div>
      {:else}
        <label class="field">
          <span>Answer</span>
          <input
            type="text"
            bind:value={freeText}
            disabled={controlsDisabled}
            placeholder="Type your response…"
          />
        </label>
      {/if}

      <label class="field">
        <span>Note <em>(optional)</em></span>
        <textarea bind:value={note} disabled={controlsDisabled} rows="2" placeholder="Add context…"></textarea>
      </label>

      {#if !matched}
        <p class="hint">Syncing with Activity…</p>
      {/if}

      <div class="actions" bind:this={actionsEl}>
        <Button onclick={onAnswer} disabled={!canAnswer}>
          {!matched ? "Syncing…" : answerMutation.isPending ? "Answering…" : "Answer"}
        </Button>
        <Button variant="destructive" onclick={onDecline} disabled={!canDecline}>
          {declineMutation.isPending ? "Declining…" : "Decline"}
        </Button>
        <Button href={activityHref} variant="none">Open Activity</Button>
      </div>

      {#if answerMutation.isError}
        <p class="error">Answer failed: {answerMutation.error?.message ?? "unknown"}</p>
      {/if}
      {#if declineMutation.isError}
        <p class="error">Decline failed: {declineMutation.error?.message ?? "unknown"}</p>
      {/if}
    </div>
  {:else if matched && effectiveStatus && effectiveStatus !== "pending"}
    <p class="hint">This request is {effectiveStatus}. The run will resume only for answered requests.</p>
  {:else}
    <p class="hint">Preparing the inline question…</p>
  {/if}
</div>

<style>
  .human-input-card {
    background-color: color-mix(in srgb, var(--yellow-primary), transparent 92%);
    border: 1px solid color-mix(in srgb, var(--yellow-primary), transparent 60%);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .human-input-card.pending {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--yellow-primary), transparent 75%);
  }

  .card-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .eyebrow {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-0, 11px);
    font-weight: var(--font-weight-7);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .status {
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-0, 11px);
    font-weight: var(--font-weight-6);
    padding: 1px var(--size-2);
  }

  .status-pending {
    background-color: color-mix(in srgb, var(--yellow-primary), transparent 75%);
    color: color-mix(in srgb, var(--yellow-primary), black 35%);
  }

  .question {
    color: var(--text-bright);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    line-height: 1.35;
    white-space: pre-wrap;
  }

  .response-form,
  .answer-block {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .options,
  .nested-choice-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .option {
    align-items: flex-start;
    background-color: var(--surface);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    cursor: pointer;
    display: flex;
    gap: var(--size-2);
    padding: var(--size-2);
  }

  .option.active {
    border-color: var(--yellow-primary);
  }

  .option input {
    margin-block-start: 0.2em;
  }

  .nested-choice-item {
    align-items: start;
    background-color: var(--surface);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: grid;
    gap: var(--size-2);
    grid-template-columns: minmax(12rem, 1fr) minmax(16rem, 1.2fr);
    padding: var(--size-2);
  }

  .nested-choice-copy {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    min-width: 0;
  }

  .nested-choice-copy strong {
    color: var(--text-bright);
    font-size: var(--font-size-1);
    line-height: 1.3;
  }

  .nested-choice-copy span {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-1);
    line-height: 1.35;
    white-space: pre-wrap;
  }

  .nested-choice-controls {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    min-width: 0;
  }

  .choice-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
  }

  .choice-button {
    align-items: center;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-round);
    cursor: pointer;
    display: inline-flex;
    gap: var(--size-1);
    padding: var(--size-1) var(--size-2);
  }

  .choice-button.active {
    border-color: var(--yellow-primary);
    color: var(--text-bright);
  }

  .choice-button input {
    margin: 0;
  }

  .nested-choice-item select,
  .choice-comment {
    background-color: var(--surface);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font: inherit;
    padding: var(--size-1) var(--size-2);
  }

  @media (max-width: 720px) {
    .nested-choice-item {
      grid-template-columns: 1fr;
    }
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .field span,
  .label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-0, 11px);
    font-weight: var(--font-weight-6);
  }

  .field em {
    font-style: normal;
    font-weight: var(--font-weight-4);
  }

  .field input,
  .field textarea {
    background-color: var(--surface);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font: inherit;
    padding: var(--size-2);
  }

  .actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  .answer-block code {
    align-self: flex-start;
    background-color: color-mix(in srgb, var(--color-text), transparent 90%);
    border-radius: var(--radius-1);
    padding: 1px var(--size-1);
  }

  .answer-block p,
  .hint,
  .error {
    font-size: var(--font-size-1);
    margin: 0;
  }

  .hint {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
  }

  .error {
    color: var(--red-primary);
  }
</style>
