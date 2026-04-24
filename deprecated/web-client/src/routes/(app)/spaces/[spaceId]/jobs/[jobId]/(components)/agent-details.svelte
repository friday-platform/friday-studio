<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { createTabs } from "@melt-ui/svelte";
  import { IconSmall } from "$lib/components/icons/small";
  import { toast } from "$lib/components/notification/notification.svelte";
  import { getServiceIcon } from "$lib/modules/integrations/icons.svelte";
  import type { AccountInfo } from "../+page";

  interface Agent {
    id: string;
    type: "agent" | "llm";
    agentId?: string;
    prompt?: string;
    tools?: string[];
  }

  let {
    agents,
    accounts,
    workspaceId,
  }: { agents: Agent[]; accounts: Map<string, AccountInfo>; workspaceId: string } = $props();

  async function handlePromptBlur(agent: Agent, newPrompt: string) {
    if (newPrompt === agent.prompt) return;

    const res = await parseResult(
      client
        .workspaceConfig(workspaceId)
        .agents[
          ":agentId"
        ].$put({ param: { agentId: agent.id }, json: { type: agent.type, prompt: newPrompt } }),
    );

    if (res.ok) {
      agent.prompt = newPrompt;
      toast({ title: "Prompt updated" });
    }
  }

  const defaultTab = agents[0]?.id;
  const {
    elements: { root, list, content, trigger },
    states: { value },
  } = createTabs({ defaultValue: defaultTab });

  /** Derive a display name from the agent id: split on ":", drop "step_", replace separators. */
  function formatName(id: string): string {
    const part = id.split(":")[1] ?? id;
    return part.replace(/^step_/, "").replace(/[-_]/g, " ");
  }

  /** Get provider keys for a single agent based on its type. */
  function getProviders(agent: Agent): string[] {
    if (agent.type === "agent" && agent.agentId) return [agent.agentId];
    return agent.tools ?? [];
  }

  function getAgentIntegrations(agent: Agent) {
    return getProviders(agent)
      .map((provider) => ({
        provider,
        account: accounts.get(provider),
        icon: getServiceIcon(provider),
      }))
      .filter((i) => i.icon || i.account);
  }
</script>

<div class="layout" {...$root} use:root>
  <ul class="list" {...$list} use:list>
    {#each agents as agent (agent.id)}
      {@const providers = getProviders(agent)}
      {@const icon = providers[0] ? getServiceIcon(providers[0]) : undefined}

      <li class:selected={$value === agent.id}>
        <button class="item" {...$trigger(agent.id)} use:trigger>
          {#if icon}
            <span class="icon">
              {#if icon.type === "component"}
                {@const Component = icon.src}
                <Component />
              {:else}
                <img src={icon.src} alt="" />
              {/if}
            </span>
          {/if}
          <span class="name">
            {formatName(agent.id)}
          </span>

          <span class="caret">
            <IconSmall.CaretRight />
          </span>
        </button>
      </li>
    {/each}
  </ul>

  {#each agents as agent (agent.id)}
    {#if $value === agent.id}
      {@const agentIntegrations = getAgentIntegrations(agent)}
      <div class="detail" {...$content(agent.id)} use:content>
        <h3 class="title">
          {formatName(agent.id)}
        </h3>

        {#if agentIntegrations.length > 0}
          <div class="section">
            <span class="form-field">Account</span>

            <div class="accounts">
              {#each agentIntegrations as { provider, account, icon } (provider)}
                {#if icon}
                  <div
                    class="account"
                    style:--background={icon.background}
                    style:--background-dark={icon.backgroundDark}
                  >
                    {#if icon.type === "component"}
                      {@const Component = icon.src}
                      <Component />
                    {:else}
                      <img src={icon.src} alt={`${provider} logo`} />
                    {/if}

                    <span class="label">
                      {#if account?.connected && account.label}
                        {account.label}
                      {:else if account && !account.connected}
                        {provider} (Disconnected)
                      {:else}
                        {provider}
                      {/if}
                    </span>
                  </div>
                {/if}
              {/each}
            </div>
          </div>
        {/if}

        {#if agent.prompt}
          <div class="section">
            <label>
              <span class="form-field">Prompt</span>
              <textarea
                class="prompt"
                value={agent.prompt}
                rows={Math.min(Math.max(agent.prompt.split("\n").length, 4), 20)}
                onblur={(e) => handlePromptBlur(agent, e.currentTarget.value)}
              ></textarea>
            </label>
          </div>
        {/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .layout {
    display: flex;
    gap: var(--size-8);
  }

  .list {
    align-items: stretch;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: var(--size-3);
    inline-size: var(--size-50);

    .item {
      align-items: center;
      background: var(--color-surface-1);
      border: var(--size-px) solid var(--color-border-1);
      border-radius: var(--radius-4);
      block-size: var(--size-9);
      cursor: pointer;
      display: flex;
      font-size: var(--font-size-2);
      gap: var(--size-1-5);
      inline-size: 100%;
      justify-content: center;
      padding-inline: var(--size-3);
      text-align: center;
      text-transform: capitalize;
      transition: all 200ms ease;
    }

    .item:hover,
    li.selected .item {
      background-color: var(--color-surface-2);
      border-color: var(--color-surface-2);
    }

    .icon {
      align-items: center;
      display: flex;
      flex-shrink: 0;
    }

    .name {
      font-weight: var(--font-weight-5);
      text-wrap: nowrap;
      text-align: start;
    }

    .caret {
      flex-shrink: 0;
      opacity: 0;
      transition: all 200ms ease;
      visibility: hidden;
    }

    li.selected .caret {
      opacity: 0.5;
      visibility: visible;
    }
  }

  .detail {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-6);
    min-inline-size: 0;

    .title {
      font-size: var(--font-size-5);
      font-weight: var(--font-weight-5);
      opacity: 0.8;
      text-transform: capitalize;
    }

    .section {
      display: flex;
      flex-direction: column;
      gap: var(--size-2);
    }

    label {
      display: flex;
      flex-direction: column;
      gap: var(--size-2);
    }

    .form-field {
      display: block;
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
    }

    textarea {
      background: var(--color-surface-1);
      border: 1px solid var(--color-border-1);
      border-radius: var(--radius-4);
      color: var(--color-text);
      font-family: var(--font-family-body, inherit);
      font-size: var(--font-size-3);
      inline-size: 100%;
      line-height: var(--font-lineheight-3);
      padding: var(--size-3);
      resize: vertical;
    }
  }

  .accounts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);

    .account {
      align-items: center;
      background-color: var(--background);
      border-radius: var(--radius-3);
      block-size: var(--size-7);
      display: flex;
      gap: var(--size-2);
      padding-inline: var(--size-2-5) var(--size-3);

      @media (prefers-color-scheme: dark) {
        background-color: var(--backgroundDark);
      }
    }

    .label {
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
    }
  }
</style>
