<script lang="ts">
  import type { ProviderCredentialCandidates } from "@atlas/schemas/workspace";
  import type { ResourceDeclaration } from "@atlas/schemas/workspace";
  import Button from "$lib/components/button.svelte";
  import { Collapsible } from "$lib/components/collapsible";
  import CaretRight from "$lib/components/icons/small/caret-right.svelte";
  import ExternalLinkIcon from "$lib/components/icons/small/external-link.svelte";
  import FileIcon from "$lib/components/icons/small/file.svelte";
  import Tooltip from "$lib/components/tooltip.svelte";
  import CredentialPicker from "$lib/modules/integrations/credential-picker.svelte";
  import { getProviderIcon } from "$lib/utils/provider-detection";
  import { transformResourcesForDisplay } from "./workspace-plan-resources.svelte.ts";

  /** Narrowed credential type — only fields the plan card UI reads. */
  type PlanCredential = { provider: string; label?: string; credentialId: string };

  /** Common shape that both v1 WorkspacePlan and v2 WorkspaceBlueprint satisfy. */
  type PlanCardData = {
    workspace: { name: string; purpose: string; details?: Array<{ label: string; value: string }> };
    signals: Array<{ id: string; name: string; signalType: string; displayLabel?: string }>;
    credentials?: PlanCredential[];
    resources?: ResourceDeclaration[];
    credentialCandidates?: ProviderCredentialCandidates[];
  };

  type Props = {
    workspacePlan: PlanCardData;
    hideControls?: boolean;
    onApprove?: (credentials?: Map<string, string>) => void;
    onTest?: () => void;
  };
  let { workspacePlan, hideControls = false, onApprove, onTest }: Props = $props();

  const signalTypeLabels: Record<string, string> = { schedule: "Schedule", http: "Webhook" };

  /** Map of provider → candidates for providers with 2+ credentials. */
  const candidatesByProvider = $derived.by(() => {
    const map = new Map<string, ProviderCredentialCandidates>();
    for (const entry of workspacePlan.credentialCandidates ?? []) {
      map.set(entry.provider, entry);
    }
    return map;
  });

  /** Track credential selections: provider → selected credentialId. */
  let credentialSelections = $state(new Map<string, string>());

  /** Get the displayed credential ID for a provider (selection or original binding). */
  function getSelectedCredentialId(provider: string, originalId: string): string {
    return credentialSelections.get(provider) ?? originalId;
  }

  const uniqueCredentials = $derived.by(() => {
    const credentials = workspacePlan.credentials ?? [];
    const seen = new Set<string>();
    const result: PlanCredential[] = [];

    for (const cred of credentials) {
      const key = `${cred.provider}:${cred.label ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(cred);
      }
    }

    return result;
  });

  const resourceDisplay = $derived.by(() => {
    const resources = workspacePlan.resources;
    if (!resources || resources.length === 0) return null;
    return transformResourcesForDisplay(resources);
  });

  /** Build the full credential state: original bindings merged with any picker selections. */
  const resolvedCredentials = $derived.by(() => {
    const map = new Map<string, string>();
    for (const cred of uniqueCredentials) {
      map.set(cred.provider, credentialSelections.get(cred.provider) ?? cred.credentialId);
    }
    return map;
  });
</script>

<div class="wrapper">
  <article class="component">
    <header>
      <h2>{workspacePlan.workspace.name}</h2>
      <p class="summary">{workspacePlan.workspace.purpose}</p>
    </header>

    {#if workspacePlan.signals.length > 0}
      <section class="signals">
        {#each workspacePlan.signals as signal (signal.id)}
          <h3>{signalTypeLabels[signal.signalType] ?? "Trigger"}</h3>
          <p>
            {signal.displayLabel ?? signal.name}
          </p>
        {/each}
      </section>
    {/if}

    {#if workspacePlan.workspace.details && workspacePlan.workspace.details.length > 0}
      <section class="details">
        <dl>
          {#each workspacePlan.workspace.details as detail, index (index)}
            <dt>{detail.label}</dt>
            <dd>{detail.value}</dd>
          {/each}
        </dl>
      </section>
    {/if}

    {#if resourceDisplay}
      <section class="resources">
        <h3>Resources</h3>

        <ul>
          {#each resourceDisplay.items as item (item.name)}
            {#if item.kind === "structured"}
              <li class="resource-card">
                <Collapsible.Root>
                  <Collapsible.Trigger size="grow">
                    {#snippet children(open)}
                      <div class="card-row">
                        <div class="card-info">
                          <span class="resource-name">{item.name}</span>
                          <span class="resource-description" class:truncate={!open}>
                            {item.description}
                          </span>
                        </div>
                        <span class="caret" class:open>
                          <CaretRight />
                        </span>
                      </div>
                    {/snippet}
                  </Collapsible.Trigger>
                  <Collapsible.Content animate>
                    <ul class="field-list">
                      {#each item.columns as col (col.name)}
                        <li>
                          <span class="field-name">{col.name}</span>
                          {#if col.description}
                            <span class="field-desc">{col.description}</span>
                          {/if}
                        </li>
                      {/each}
                      {#if item.nested}
                        {#each item.nested as nested (nested.name)}
                          <li class="nested-group">
                            {nested.name}
                            <ul>
                              {#each nested.columns as col (col.name)}
                                <li>
                                  <span class="field-name">{col.name}</span>
                                  {#if col.description}
                                    <span class="field-desc">{col.description}</span>
                                  {/if}
                                </li>
                              {/each}
                            </ul>
                          </li>
                        {/each}
                      {/if}
                    </ul>
                  </Collapsible.Content>
                </Collapsible.Root>
              </li>
            {:else if item.kind === "document"}
              <li class="resource-card">
                <div class="card-row">
                  <FileIcon />
                  <div class="card-info">
                    <span class="resource-name">{item.name}</span>
                    <span class="resource-description">{item.description}</span>
                  </div>
                </div>
              </li>
            {:else if item.kind === "external"}
              {@const IconComponent = getProviderIcon(item.provider)}
              {#if item.ref}
                <li class="resource-card clickable">
                  <a href={item.ref} target="_blank" rel="noopener noreferrer" class="card-link">
                    <div class="card-row">
                      <IconComponent />
                      <span class="resource-name">{item.name}</span>
                      <span class="external-link">
                        <ExternalLinkIcon />
                      </span>
                    </div>
                    <span class="resource-description truncate external-desc">
                      {item.description}
                    </span>
                  </a>
                </li>
              {:else}
                <li class="resource-card">
                  <div class="card-row">
                    <IconComponent />
                    <span class="resource-name">{item.name}</span>
                    <Tooltip as="span" label="An agent will create this when the job first runs">
                      <span class="status-badge">Pending</span>
                    </Tooltip>
                  </div>
                  <span class="resource-description truncate external-desc">
                    {item.description}
                  </span>
                </li>
              {/if}
            {/if}
          {/each}
        </ul>

        {#if resourceDisplay.overflow > 0}
          <p class="overflow-label">+ {resourceDisplay.overflow} more resources</p>
        {/if}
      </section>
    {/if}

    {#if uniqueCredentials.length > 0}
      <section class="integrations">
        <h3>Integrations</h3>

        <ul>
          {#each uniqueCredentials as credential (credential.credentialId)}
            {@const IconComponent = getProviderIcon(credential.provider)}
            {@const providerCandidates = candidatesByProvider.get(credential.provider)}
            <li>
              <IconComponent />

              {#if providerCandidates && providerCandidates.candidates.length >= 2}
                <CredentialPicker
                  credentials={providerCandidates.candidates}
                  selectedId={getSelectedCredentialId(credential.provider, credential.credentialId)}
                  onselect={(id) => {
                    const next = new Map(credentialSelections);
                    next.set(credential.provider, id);
                    credentialSelections = next;
                  }}
                />
              {:else if credential.label}
                <span>{credential.label}</span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if !hideControls}
      <div class="actions">
        <Button
          size="small"
          onclick={() => {
            if (onApprove) onApprove(resolvedCredentials.size > 0 ? resolvedCredentials : undefined);
          }}
        >
          Approve
        </Button>

        <Button
          size="small"
          onclick={() => {
            if (onTest) onTest();
          }}
        >
          Test Plan
        </Button>
      </div>
    {/if}
  </article>
</div>

<style>
  .wrapper {
    inline-size: fit-content;
    max-inline-size: 100%;
  }

  .component {
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-4);
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    padding: var(--size-6);
  }

  header {
    h2 {
      font-size: var(--font-size-4);
      font-weight: var(--font-weight-5);
      line-height: var(--font-lineheight-0);
      margin-block-end: var(--size-1-5);
    }

    .summary {
      color: var(--color-text);
      font-size: var(--font-size-4);
      line-height: var(--font-lineheight-3);
      max-inline-size: 50ch;
      opacity: 0.8;
      text-wrap-style: balance;
    }
  }

  section {
    h3 {
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
      line-height: var(--font-lineheight-0);
      opacity: 0.6;
    }
  }

  .signals {
    p {
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
      padding-block-start: var(--size-1);
    }
  }

  .details {
    dl {
      align-items: center;
      display: grid;
      gap: var(--size-1);

      grid-template-columns: var(--size-32) 1fr;
      grid-auto-flow: row;
    }

    dt,
    dd {
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
    }

    dt {
      line-height: var(--font-lineheight-1);
      opacity: 0.6;
    }
  }

  .resources {
    ul {
      align-items: start;
      display: grid;
      gap: var(--size-2);
      grid-template-columns: repeat(2, minmax(0, var(--size-72)));
      padding-block-start: var(--size-2);
    }

    .resource-card {
      border: var(--size-px) solid var(--color-border-1);
      border-radius: var(--radius-2-5);
      display: flex;
      flex-direction: column;
      gap: var(--size-0-5);
      padding: var(--size-3);
    }

    .card-row {
      align-items: flex-start;
      display: flex;
      gap: var(--size-2);
      text-align: start;

      > :global(svg) {
        block-size: var(--size-4);
        flex: none;
        inline-size: var(--size-4);
        margin-block-start: var(--size-0-5);
      }
    }

    .card-info {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: var(--size-0-5);
      min-inline-size: 0;
    }

    .resource-name {
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
    }

    .card-row > .resource-name {
      flex: 1;
    }

    .card-link {
      color: inherit;
      display: flex;
      flex-direction: column;
      gap: var(--size-0-5);
      text-decoration: none;
    }

    .clickable {
      cursor: pointer;
    }

    .external-link {
      align-items: center;
      color: currentcolor;
      display: flex;
      flex: none;
      margin-block-start: var(--size-0-5);
      opacity: 0.4;
      transition: opacity 150ms ease;

      :global(svg) {
        block-size: var(--size-3-5);
        inline-size: var(--size-3-5);
      }

      &:hover {
        opacity: 0.8;
      }
    }

    .status-badge {
      border: var(--size-px) solid var(--color-border-1);
      border-radius: var(--radius-2);
      color: var(--text-3);
      flex: none;
      font-size: var(--font-size-1);
      opacity: 0.6;
      padding: 0 var(--size-1);
      white-space: nowrap;
    }

    .resource-description {
      font-size: var(--font-size-2);
      opacity: 0.6;

      &.truncate {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      &.external-desc {
        padding-inline-start: calc(var(--size-4) + var(--size-2));
      }
    }

    .caret {
      align-items: center;
      display: flex;
      flex: none;
      margin-block-start: var(--size-0-5);
      transition: transform 150ms ease;

      :global(svg) {
        block-size: var(--size-4);
        inline-size: var(--size-4);
        opacity: 0.4;
      }

      &.open {
        transform: rotate(90deg);
      }
    }

    .field-list {
      border-block-start: var(--size-px) solid var(--color-border-1);
      display: flex;
      flex-direction: column;
      gap: var(--size-2);
      margin-block-start: var(--size-3);
      padding-block-start: var(--size-3);

      li {
        display: flex;
        flex-direction: column;
        font-size: var(--font-size-2);
        padding-inline-start: var(--size-1);
      }

      .field-name {
        font-weight: var(--font-weight-5);
        opacity: 0.8;
      }

      .field-desc {
        opacity: 0.5;
      }
    }

    .nested-group {
      font-weight: var(--font-weight-5);

      ul {
        gap: var(--size-1);
        padding-block-start: var(--size-1);
        padding-inline-start: var(--size-3);
      }
    }

    .overflow-label {
      font-size: var(--font-size-2);
      opacity: 0.6;
      padding-block-start: var(--size-2);
    }
  }

  .integrations {
    ul {
      display: flex;
      flex-direction: column;
      gap: var(--size-1);
      padding-block-start: var(--size-2);
    }

    li {
      align-items: center;
      display: flex;
      gap: var(--size-2);

      :global(svg) {
        block-size: var(--size-4);
        flex: none;
        inline-size: var(--size-4);
      }

      span {
        font-size: var(--font-size-2);
        font-weight: var(--font-weight-4-5);
        opacity: 0.6;
      }
    }
  }

  .actions {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }
</style>
