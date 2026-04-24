<script lang="ts">
  import type { AtlasUIMessage } from "@atlas/agent-sdk";
  import { client, parseResult } from "@atlas/client/v2";
  import { stringifyError } from "@atlas/utils";
  import { createQuery } from "@tanstack/svelte-query";
  import { Page } from "$lib/components/page";
  import { getServiceIcon } from "$lib/modules/integrations/icons.svelte";
  import { stripSlackAppId } from "$lib/modules/integrations/utils";

  interface Props {
    messages: AtlasUIMessage[];
  }

  const { messages }: Props = $props();

  /** Providers that appear in credential-linked message parts */
  const linkedProviders = $derived.by((): string[] => {
    const seen = new Set<string>();
    const providers: string[] = [];

    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type !== "data-credential-linked") continue;
        const provider = part.data?.provider;
        if (!provider || seen.has(provider)) continue;
        seen.add(provider);
        providers.push(provider);
      }
    }

    return providers;
  });

  /** Fetch credential summary from Link to get labels (email, workspace name, etc.) */
  const credentialSummaryQuery = createQuery(() => ({
    queryKey: ["link-credential-summary", linkedProviders.length],
    queryFn: async () => {
      const res = await parseResult(client.link.v1.summary.$get({ query: {} }));
      if (!res.ok) throw new Error(stringifyError(res.error));
      return res.data.credentials;
    },
    enabled: linkedProviders.length > 0,
  }));

  interface Account {
    provider: string;
    displayName: string;
    label: string | undefined;
  }

  const accounts = $derived.by((): Account[] => {
    const creds = credentialSummaryQuery.data ?? [];

    return linkedProviders.map((provider) => {
      const cred = creds.find((c) => c.provider === provider);
      const rawLabel = cred?.displayName ?? cred?.label;
      return {
        provider,
        displayName: formatProviderName(provider),
        label: rawLabel && provider === "slack-app" ? stripSlackAppId(rawLabel) : rawLabel,
      };
    });
  });

  function formatProviderName(provider: string): string {
    return provider
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
</script>

<Page.SidebarSection title="Accounts">
  {#if accounts.length > 0}
    <ul class="accounts-list">
      {#each accounts as account (account.provider)}
        {@const icon = getServiceIcon(account.provider)}
        <li class="account-item">
          {#if icon}
            <span class="account-icon">
              {#if icon.type === "component"}
                <icon.src />
              {:else}
                <img src={icon.src} alt="" />
              {/if}
            </span>
          {/if}
          <div class="account-info">
            <span>{account.displayName}</span>
            {#if account.label}
              <span class="account-label">{account.label}</span>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {:else}
    <a
      class="empty-link"
      href="https://docs.hellofriday.ai/capabilities-and-integrations/overview"
      target="_blank"
      rel="noopener noreferrer"
    >
      Learn about Accounts and Integrations
    </a>
  {/if}
</Page.SidebarSection>

<style>
  .accounts-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .account-item {
    align-items: start;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-2);
  }

  .account-icon {
    block-size: var(--size-4);
    display: flex;
    inline-size: var(--size-4);
    flex-shrink: 0;
    margin-block-start: var(--size-px);
  }

  .account-icon :global(img) {
    block-size: 100%;
    inline-size: 100%;
    object-fit: contain;
  }

  .account-info {
    display: flex;
    flex-direction: column;
  }

  .account-label {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4-5);
    opacity: 0.6;
  }

  .empty-link {
    color: var(--color-text);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-4-5);
    line-height: var(--font-lineheight-1);
    opacity: 0.6;
    text-decoration: underline;
    transition: opacity 150ms ease;
  }

  .empty-link:hover {
    opacity: 1;
  }
</style>
