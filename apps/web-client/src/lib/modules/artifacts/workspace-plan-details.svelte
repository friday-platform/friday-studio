<script lang="ts">
  import type { CredentialBinding } from "@atlas/core/artifacts";
  import Button from "$lib/components/button.svelte";
  import GlobeIcon from "$lib/components/icons/globe.svelte";
  import Anthropic from "$lib/components/icons/integrations/anthropic.svelte";
  import AtlassianIcon from "$lib/components/icons/integrations/atlassian.svelte";
  import GithubIcon from "$lib/components/icons/integrations/github.svelte";
  import LinearIcon from "$lib/components/icons/integrations/linear.svelte";
  import NotionIcon from "$lib/components/icons/integrations/notion.svelte";
  import PosthogIcon from "$lib/components/icons/integrations/posthog.svelte";
  import SentryIcon from "$lib/components/icons/integrations/sentry.svelte";
  import SlackIcon from "$lib/components/icons/integrations/slack-color.svelte";

  /** Common shape that both v1 WorkspacePlan and v2 WorkspaceBlueprint satisfy. */
  type PlanCardData = {
    workspace: { name: string; purpose: string; details?: Array<{ label: string; value: string }> };
    signals: Array<{ id: string; name: string; signalType: string; displayLabel?: string }>;
    credentials?: CredentialBinding[];
  };

  type Props = {
    workspacePlan: PlanCardData;
    hideControls?: boolean;
    onApprove?: () => void;
    onTest?: () => void;
  };
  let { workspacePlan, hideControls = false, onApprove, onTest }: Props = $props();

  // Map signal types to display labels
  const signalTypeLabels: Record<string, string> = { schedule: "Schedule", http: "Webhook" };

  // Map provider names to icon components
  const providerIcons: Record<string, typeof GithubIcon> = {
    anthropic: Anthropic,
    github: GithubIcon,
    slack: SlackIcon,
    notion: NotionIcon,
    linear: LinearIcon,
    atlassian: AtlassianIcon,
    jira: AtlassianIcon,
    sentry: SentryIcon,
    posthog: PosthogIcon,
  };

  function getProviderIcon(provider: string) {
    const normalized = provider.toLowerCase();
    return providerIcons[normalized] ?? GlobeIcon;
  }

  // Get unique credentials by provider + label combination for display
  const uniqueCredentials = $derived.by(() => {
    const credentials = workspacePlan.credentials ?? [];
    const seen = new Set<string>();
    const result: CredentialBinding[] = [];

    for (const cred of credentials) {
      const key = `${cred.provider}:${cred.label ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(cred);
      }
    }

    return result;
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

    {#if uniqueCredentials.length > 0}
      <section class="integrations">
        <h3>Integrations</h3>

        <ul>
          {#each uniqueCredentials as credential (credential.credentialId)}
            {@const IconComponent = getProviderIcon(credential.provider)}
            <li>
              <IconComponent />

              {#if credential.label}
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
            if (onApprove) onApprove();
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
