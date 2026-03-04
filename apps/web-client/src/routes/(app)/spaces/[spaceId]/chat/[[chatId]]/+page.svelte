<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import ChatBufferBlur from "$lib/components/chat-buffer-blur.svelte";
  import Dot from "$lib/components/dot.svelte";
  import { Page } from "$lib/components/page";
  import ChatProvider from "$lib/modules/conversation/chat-provider.svelte";
  import { scrollAttachment } from "$lib/modules/conversation/context.svelte";
  import Footer from "$lib/modules/conversation/footer.svelte";
  import Form from "$lib/modules/conversation/form.svelte";
  import Messages from "$lib/modules/conversation/messages.svelte";
  // import Outline from "$lib/modules/conversation/outline.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const appCtx = getAppContext();

  // TODO: wire up to real workspace conversations
  const recentChats = [
    { id: "1", name: "Metrics analysis" },
    { id: "2", name: "Validating data" },
    { id: "3", name: "Signup conversion trends" },
    { id: "4", name: "Token usage breakdown" },
    { id: "5", name: "Revenue forecasting" },
    { id: "6", name: "User retention deep dive" },
    { id: "7", name: "Latency percentile review" },
    { id: "8", name: "Onboarding flow review" },
    { id: "9", name: "API latency investigation" },
    { id: "10", name: "Queue backpressure tuning" },
    { id: "11", name: "Weekly standup notes" },
    { id: "12", name: "Database migration plan" },
    { id: "13", name: "Churn prediction model" },
    { id: "14", name: "Dependency upgrade audit" },
    { id: "15", name: "Feature prioritization" },
    { id: "16", name: "Search relevance tuning" },
    { id: "17", name: "Session replay analysis" },
    { id: "18", name: "Cost optimization" },
    { id: "19", name: "Incident postmortem" },
    { id: "20", name: "Funnel analysis" },
    { id: "21", name: "Embedding similarity check" },
    { id: "22", name: "Sprint retrospective" },
    { id: "23", name: "Cache invalidation strategy" },
    { id: "24", name: "Payload size reduction" },
    { id: "25", name: "Customer feedback summary" },
    { id: "26", name: "Load testing results" },
    { id: "27", name: "Index fragmentation review" },
    { id: "28", name: "Permissions audit" },
    { id: "29", name: "Notification redesign" },
    { id: "30", name: "Connection pool sizing" },
    { id: "31", name: "Data pipeline debugging" },
    { id: "32", name: "A/B test evaluation" },
    { id: "33", name: "Retry policy configuration" },
    { id: "34", name: "Billing reconciliation" },
    { id: "35", name: "Error rate spike" },
    { id: "36", name: "Tenant isolation review" },
    { id: "37", name: "Roadmap planning Q3" },
    { id: "38", name: "Webhook reliability" },
    { id: "39", name: "Memory leak investigation" },
    { id: "40", name: "SSO integration" },
    { id: "41", name: "Content moderation rules" },
    { id: "42", name: "Cold start optimization" },
    { id: "43", name: "Export performance" },
    { id: "44", name: "Deployment checklist" },
    { id: "45", name: "Certificate rotation plan" },
    { id: "46", name: "Rate limiting strategy" },
    { id: "47", name: "User segmentation" },
    { id: "48", name: "Query plan analysis" },
    { id: "49", name: "Accessibility review" },
    { id: "50", name: "Schema validation errors" },
    { id: "51", name: "Failover testing results" },
    { id: "52", name: "Mobile responsive fixes" },
    { id: "53", name: "Logging improvements" },
    { id: "54", name: "Throughput benchmarking" },
  ];
</script>

<ChatProvider
  chatId={data.chatId}
  isNew={data.isNew}
  initialMessages={data.messages}
  artifacts={data.artifacts}
  onPostSuccess={(id) =>
    goto(resolve(`/spaces/[spaceId]/chat/[chatId]`, { spaceId: data.spaceId, chatId: id }), {
      replaceState: true,
    })}
>
  {#snippet children(context)}
    <Page.Root>
      <Page.Content padded={false} {@attach scrollAttachment(data.isNew, context)}>
        {#snippet prepend()}
          <Breadcrumbs.Root fixed>
            <Breadcrumbs.Item href={appCtx.routes.spaces.item(data.spaceId)} showCaret>
              {#snippet prepend()}
                <Dot color={data.workspace.metadata?.color} />
              {/snippet}
              {data.workspace.name}
            </Breadcrumbs.Item>
          </Breadcrumbs.Root>
        {/snippet}

        {#if data.isNew}
          <div class="wrapper">
            <h1>Chat with {data.workspace.name}</h1>

            <div class="form-wrapper">
              <Form />
            </div>
          </div>
        {:else}
          <Messages />
          <Footer>
            <Form />
          </Footer>

          <ChatBufferBlur />
        {/if}
      </Page.Content>
      {#if data.isNew && recentChats}
        <Page.Sidebar>
          <div>
            <h2>Conversations</h2>
            <ul class="conversations">
              {#each recentChats as chat (chat.id)}
                <li>
                  <a
                    href={resolve(`/spaces/[spaceId]/chat/[chatId]`, {
                      spaceId: data.spaceId,
                      chatId: chat.id,
                    })}
                  >
                    {chat.name}
                  </a>
                </li>
              {/each}
            </ul>
          </div>
        </Page.Sidebar>
      {/if}
    </Page.Root>
  {/snippet}
</ChatProvider>

<style>
  h1 {
    font-size: var(--font-size-8);
    font-weight: var(--font-weight-6);
    padding-block: var(--size-16) var(--size-4);
    text-align: center;
  }

  h2 {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
    opacity: 0.6;
  }

  .wrapper {
    block-size: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    margin-block-end: var(--size-32);
  }

  .form-wrapper {
    inline-size: 100%;
    margin: 0 auto;
    max-inline-size: var(--size-160);
    padding-inline: var(--size-8);
  }

  .conversations {
    & {
      margin-block: var(--size-2) 0;
    }

    a {
      align-items: center;
      block-size: var(--size-7);
      display: inline flex;
      font-weight: var(--font-weight-5);

      &:hover {
        text-decoration: underline;
      }
    }
  }
</style>
