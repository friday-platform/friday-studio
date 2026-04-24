<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import type {
    EphemeralChunk,
    SessionStreamEvent,
    SessionView,
  } from "@atlas/core/session/session-events";
  import { initialSessionView, reduceSessionEvent } from "@atlas/core/session/session-reducer";
  import { stringifyError } from "@atlas/utils";
  import { experimental_streamedQuery } from "@tanstack/query-core";
  import { createQuery } from "@tanstack/svelte-query";
  import { resolve } from "$app/paths";
  import Button from "$lib/components/button.svelte";
  import Dot from "$lib/components/dot.svelte";
  import FormattedData from "$lib/components/formatted-data.svelte";
  import { Icons } from "$lib/components/icons";
  import { IconSmall } from "$lib/components/icons/small";
  import JsonHighlight from "$lib/components/json-highlight.svelte";
  import { Page } from "$lib/components/page";
  import { getServiceIcon, type ServiceIcon } from "$lib/modules/integrations/icons.svelte";
  import { formatDuration, formatSessionDate } from "$lib/utils/date";
  import { fetchSessionView, sessionEventStream } from "$lib/utils/session-event-stream";
  import { onMount } from "svelte";
  import AgentBlockCard from "../(components)/agent-block-card.svelte";
  import { parseError } from "../(components)/parse-error";
  import { StepBlock } from "../(components)/step-block";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const isAlreadyFinished = $derived(
    data.initialStatus === "completed" || data.initialStatus === "failed",
  );

  const query = createQuery(() => ({
    queryKey: ["session-stream", data.sessionId],
    queryFn: isAlreadyFinished
      ? () => fetchSessionView(data.sessionId)
      : experimental_streamedQuery<SessionStreamEvent | EphemeralChunk, SessionView>({
          streamFn: () => sessionEventStream(data.sessionId),
          reducer: reduceSessionEvent,
          initialValue: initialSessionView(),
        }),
  }));

  const isOutdated = $derived(query.error?.message?.includes("outdated format") ?? false);

  // Job details query
  const jobQuery = createQuery(() => ({
    queryKey: ["job-details", query.data?.workspaceId, query.data?.jobName],
    queryFn: async () => {
      if (!query.data) throw new Error("Session not loaded");
      const res = await parseResult(
        client.jobs[":jobId"][":workspaceId"].$get({
          param: { jobId: query.data.jobName, workspaceId: query.data.workspaceId },
        }),
      );
      if (!res.ok) throw new Error(stringifyError(res.error));
      return res.data;
    },
    enabled: Boolean(query.data?.workspaceId && query.data?.jobName),
  }));

  // Workspace details query
  const workspaceQuery = createQuery(() => ({
    queryKey: ["workspace-details", query.data?.workspaceId],
    queryFn: async () => {
      if (!query.data) throw new Error("Session not loaded");
      const res = await parseResult(
        client.workspace[":workspaceId"].$get({ param: { workspaceId: query.data.workspaceId } }),
      );
      if (!res.ok) throw new Error(stringifyError(res.error));
      return res.data;
    },
    enabled: Boolean(query.data?.workspaceId),
  }));

  // Workspace config credentials (provider → credentialId mapping)
  const configCredentialsQuery = createQuery(() => ({
    queryKey: ["workspace-config-credentials", query.data?.workspaceId],
    queryFn: async () => {
      if (!query.data) throw new Error("Session not loaded");
      const res = await parseResult(
        client.workspaceConfig(query.data.workspaceId).credentials.$get(),
      );
      if (!res.ok) throw new Error(stringifyError(res.error));
      return res.data.credentials;
    },
    enabled: Boolean(query.data?.workspaceId),
  }));

  // Link credential summary (credentialId → label)
  const credentialSummaryQuery = createQuery(() => ({
    queryKey: ["link-credential-summary"],
    queryFn: async () => {
      const res = await parseResult(client.link.v1.summary.$get({ query: {} }));
      if (!res.ok) throw new Error(stringifyError(res.error));
      return res.data.credentials;
    },
    enabled: Boolean(query.data?.workspaceId),
  }));

  const workspaceName = $derived(workspaceQuery.data?.name);
  const jobDisplayName = $derived(jobQuery.data?.name || query.data?.jobName);
  const displayTitle = $derived(jobDisplayName || data.sessionId);
  const sessionDate = $derived(
    query.data?.startedAt ? formatSessionDate(query.data.startedAt) : "",
  );
  const duration = $derived(
    query.data?.durationMs ? formatDuration(0, query.data.durationMs) : null,
  );
  const isFinished = $derived(
    query.data?.status === "completed" || query.data?.status === "failed",
  );

  // Job-level integrations: job providers → config credentials → Link labels
  const jobIntegrations = $derived.by(() => {
    const jobProviders = jobQuery.data?.integrations ?? [];
    if (jobProviders.length === 0) return [];

    // Build provider → credentialId from workspace config
    const configCreds = configCredentialsQuery.data ?? [];
    const providerToCredId = new Map<string, string>();
    for (const cred of configCreds) {
      if (cred.provider && cred.credentialId) {
        providerToCredId.set(cred.provider, cred.credentialId);
      }
    }

    // Build credentialId → label from Link summary
    const linkCreds = credentialSummaryQuery.data ?? [];
    const credIdToLabel = new Map(linkCreds.map((c) => [c.id, c.displayName ?? c.label]));

    return jobProviders
      .map((provider) => {
        const icon = getServiceIcon(provider);
        const credId = providerToCredId.get(provider);
        const label = credId ? credIdToLabel.get(credId) : undefined;
        const connected = Boolean(credId);
        return { provider, icon, label, connected };
      })
      .filter((i) => i.icon != null);
  });

  // Agent-to-icon mapping: join session blocks to job agents via stateId
  const agentIconMap = $derived.by(() => {
    const map = new Map<string, ServiceIcon>();
    const agents = jobQuery.data?.agents;
    if (!agents) return map;

    for (const block of query.data?.agentBlocks ?? []) {
      if (!block.stateId) continue;

      const matched = agents.find((a) => "stateId" in a && a.stateId === block.stateId);
      if (!matched) continue;

      let icon: ServiceIcon | undefined;

      // Agent-type: use agentId as provider
      if ("agentId" in matched && matched.agentId) {
        icon = getServiceIcon(matched.agentId);
      }
      // LLM-type: use first tool as provider
      if (!icon && "tools" in matched && Array.isArray(matched.tools) && matched.tools.length > 0) {
        icon = getServiceIcon(matched.tools[0]);
      }

      if (icon) map.set(block.agentName, icon);
    }
    return map;
  });

  function formatProviderName(provider: string): string {
    return provider
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  onMount(() => {
    trackEvent(GA4.SESSION_VIEW, {
      session_id: data.sessionId,
      session_status: query.data?.status ?? "unknown",
    });
  });
</script>

<Page.Root>
  <Page.Content>
    {#snippet header()}
      <div>
        {#if query.data}
          {#if query.data.status !== "completed"}
            <span
              class="status"
              class:failed={query.data.status === "failed"}
              class:active={query.data.status === "active" || query.isFetching}
              class:skipped={query.data.status === "skipped"}
            >
              {#if query.data.status === "failed"}
                <IconSmall.Close />
                Failed
              {:else if query.data.status === "skipped"}
                <IconSmall.Close />
                Skipped
              {:else if query.isFetching}
                <span class="spin"><IconSmall.Progress /></span>
                Running
              {/if}
            </span>
          {/if}
        {/if}

        <h1>{displayTitle}</h1>
      </div>
    {/snippet}

    {#snippet description()}
      {#if query.isFetching && !isFinished}
        <p>This session is in progress</p>
      {:else if query.data?.aiSummary}
        <p>{query.data.aiSummary.summary}</p>
      {/if}
    {/snippet}

    <div>
      {#if query.isPending}
        <div class="loading">Loading session...</div>
      {:else if isOutdated}
        <div class="outdated">
          <IconSmall.Close />
          <p>This session uses an outdated storage format and cannot be displayed.</p>
        </div>
      {:else if query.isError}
        <div class="error-state">
          <p>Connection lost</p>
          <Button onclick={() => query.refetch()}>Retry</Button>
        </div>
      {:else if query.data}
        <p class="session-date">
          {#if sessionDate}
            <time title={query.data.startedAt} datetime={query.data.startedAt}>
              {sessionDate}
            </time>
          {/if}
          {#if duration}
            <span>•</span>
            <span>{duration}</span>
          {/if}
        </p>

        {#if query.data.error && !query.data.aiSummary}
          <div class="session-error">
            <pre class="error-message">{query.data.error}</pre>
          </div>
        {/if}

        <div class="steps">
          {#each query.data.agentBlocks as block, i (i)}
            {@const icon = agentIconMap.get(block.agentName)}
            <AgentBlockCard
              {block}
              {icon}
              defaultOpen={!query.isFetching || block.status === "running"}
            />
          {/each}
          {#if isFinished}
            {@const resultTitle = query.data.status === "completed" ? "Complete" : "Failed"}
            {@const resultSubtitle =
              query.data.status === "completed" && duration
                ? `Succeeded in ${duration}`
                : query.data.status === "failed" && duration
                  ? `After ${duration}`
                  : undefined}
            {@const sessionError = query.data.error ? parseError(query.data.error) : null}
            <StepBlock.Root>
              {#snippet header()}
                <StepBlock.Header title={resultTitle} subtitle={resultSubtitle}>
                  {#snippet fallbackIcon()}
                    {#if sessionError}
                      <span style:color="var(--red-3)">
                        <Icons.Close />
                      </span>
                    {:else}
                      <span style:color="var(--green-3)">
                        <Icons.StyledCheckmark />
                      </span>
                    {/if}
                  {/snippet}
                </StepBlock.Header>
              {/snippet}
              {#if sessionError}
                {#if "prefix" in sessionError}
                  <p class="error-label">{sessionError.prefix}</p>
                  <FormattedData variant="error" copyText={sessionError.reason} maxLines={7}>
                    <p>{sessionError.reason}</p>
                  </FormattedData>
                {:else}
                  <FormattedData variant="error" copyText={sessionError.raw} maxLines={7}>
                    <pre>{sessionError.raw}</pre>
                  </FormattedData>
                {/if}
              {:else if query.data.results && Object.keys(query.data.results).length > 0}
                <FormattedData copyText={JSON.stringify(query.data.results, null, 2)} maxLines={7}>
                  <JsonHighlight code={JSON.stringify(query.data.results, null, 2)} />
                </FormattedData>
              {/if}
            </StepBlock.Root>
          {/if}
        </div>
      {/if}
    </div>
  </Page.Content>

  <Page.Sidebar>
    {#if query.data}
      <div class="sidebar-section">
        <h3>Job</h3>
        <div class="job-details" class:error={workspaceQuery.isError}>
          {#if workspaceName}
            <p class="workspace-name">
              <Dot color={workspaceQuery.data?.metadata?.color} />
              {workspaceName}
            </p>
            <a
              class="job-name"
              href={resolve("/spaces/[spaceId]/jobs/[jobId]", {
                spaceId: query.data.workspaceId,
                jobId: query.data.jobName,
              })}
            >
              {jobDisplayName ?? query.data.jobName}
            </a>
          {:else if workspaceQuery.isError}
            <p class="workspace-name">Space unavailable</p>
            <span class="job-name">{query.data.jobName}</span>
          {/if}
        </div>
      </div>

      {#if query.data.aiSummary?.keyDetails && query.data.aiSummary.keyDetails.length > 0}
        <div class="sidebar-section">
          <h3>Summary</h3>

          <dl class="key-details">
            {#each query.data.aiSummary.keyDetails as detail (detail.label)}
              <div class="key-detail-row">
                <dt>{detail.label}</dt>
                <dd>
                  {#if detail.url}
                    <a href={detail.url} target="_blank" rel="noopener noreferrer">
                      {detail.value}
                    </a>
                  {:else}
                    {detail.value}
                  {/if}
                </dd>
              </div>
            {/each}
          </dl>
        </div>
      {/if}

      {#if jobIntegrations.length > 0}
        <div class="sidebar-section">
          <h3>Accounts</h3>
          <ul class="accounts-list">
            {#each jobIntegrations as { provider, icon, label, connected } (provider)}
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
                  <span>{formatProviderName(provider)}</span>
                  {#if connected && label}
                    <span class="account-label">{label}</span>
                  {:else if !connected}
                    <span class="account-label disconnected">Disconnected</span>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    {/if}
  </Page.Sidebar>
</Page.Root>

<style>
  .session-date {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-6);
    gap: var(--size-1);
  }

  .spin {
    animation: spin 2s linear infinite;
    display: flex;
  }

  .status {
    align-items: center;
    block-size: var(--size-5-5);
    border: 1px solid transparent;
    border-radius: var(--radius-2-5);
    color: var(--color-text-2);
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    inline-size: fit-content;
    margin-block-end: var(--size-4);
    padding-inline: var(--size-1-5) var(--size-2);

    &.failed {
      background: var(--red-1);
      color: var(--red-3);
    }

    &.active {
      background: var(--yellow-1);
      color: var(--yellow-3);
    }

    &.skipped {
      background: color-mix(in srgb, var(--color-text) 5%, transparent);
    }
  }

  .key-details {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
  }

  .key-detail-row {
    align-items: start;
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .key-detail-row dt {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .key-detail-row dd {
    color: color-mix(in srgb, var(--color-text) 60%, transparent);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4-5);
  }

  .key-detail-row dd a {
    color: color-mix(in srgb, var(--color-text) 60%, transparent);
    text-decoration: underline;
    text-underline-offset: var(--size-0-5);
    text-decoration-color: color-mix(in srgb, currentColor, transparent 70%);
  }

  .steps {
    display: flex;
    flex-direction: column;
    padding-block-start: var(--size-2);
  }

  .session-error {
    background-color: color-mix(in srgb, var(--color-red) 10%, transparent);
    border-inline-start: 3px solid var(--color-red);
    border-radius: var(--radius-1);
    margin-block-start: var(--size-6);
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
  }

  .error-message {
    color: var(--color-red);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .error-label {
    color: var(--red-3);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
  }

  .loading {
    color: var(--text-3);
    font-size: var(--font-size-4);
    padding-block-start: var(--size-8);
  }

  .outdated {
    align-items: center;
    color: var(--text-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding-block-start: var(--size-12);
    text-align: center;

    p {
      font-size: var(--font-size-4);
    }

    :global(svg) {
      block-size: 24px;
      color: var(--color-red);
      inline-size: 24px;
    }
  }

  .error-state {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding-block-start: var(--size-12);
    text-align: center;

    p {
      color: var(--text-3);
      font-size: var(--font-size-4);
    }
  }

  /* Sidebar */
  .sidebar-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);

    h3 {
      font-size: var(--font-size-5);
      font-weight: var(--font-weight-5);
      opacity: 0.6;
    }
  }

  .workspace-name {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4-5);
    gap: var(--size-2);
  }

  .job-details {
    .job-name {
      color: var(--color-text);
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-4-5);
      margin-block-start: var(--size-0-5);
      margin-inline-start: var(--size-10);
      position: relative;
      text-decoration: none;

      &:hover {
        text-decoration: underline;
      }

      &:before {
        content: "";
        border: var(--size-px) solid var(--color-border-1);
        border-inline-end: 0;
        border-block-start: 0;
        border-end-start-radius: var(--radius-1);
        block-size: var(--size-2);
        inline-size: var(--size-2);
        inset-inline-end: 100%;
        inset-block-start: var(--size-0-5);
        margin-inline-end: var(--size-1-5);
        position: absolute;
      }
    }

    &.error .job-name {
      margin-inline-start: var(--size-6);

      &:hover {
        text-decoration: none;
      }
    }
  }

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

  .account-info {
    display: flex;
    flex-direction: column;
  }

  .account-label {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4-5);
    opacity: 0.6;

    &.disconnected {
      color: var(--color-red);
      opacity: 1;
    }
  }

  .account-icon {
    block-size: var(--size-4);
    display: flex;
    inline-size: var(--size-4);
    margin-block-start: var(--size-px);
  }

  .account-icon img {
    block-size: 100%;
    inline-size: 100%;
    object-fit: contain;
  }
</style>
