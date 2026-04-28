<script lang="ts">
  import { Button, MarkdownRendered, PageLayout, markdownToHTML, toast } from "@atlas/ui";
  import DOMPurify from "dompurify";
  import { page } from "$app/state";
  import { getClient } from "$lib/client.ts";

  interface SignalSummary {
    id: string;
    title?: string;
    description?: string;
    provider?: string;
  }
  interface AgentSummary {
    id: string;
    type?: string;
    description?: string;
  }
  interface JobSummary {
    id: string;
    title?: string;
    description?: string;
  }

  interface DetailItem {
    slug: string;
    name: string;
    description: string;
    hasWorkspaceYml: boolean;
    signals: SignalSummary[];
    agents: AgentSummary[];
    jobs: JobSummary[];
    readme: string;
    source: { repo: string; ref: string; path: string; htmlUrl: string };
  }

  const slug = $derived(page.params.slug ?? "");

  let item = $state<DetailItem | null>(null);
  let loading = $state(true);
  let errorMsg = $state<string | null>(null);
  let importing = $state(false);

  async function load(): Promise<void> {
    if (!slug) return;
    loading = true;
    errorMsg = null;
    try {
      const res = await getClient().api.discover.item.$get({ query: { slug } });
      if (!res.ok) {
        errorMsg = `Failed to load (HTTP ${res.status})`;
        return;
      }
      const data = await res.json();
      if ("error" in data && typeof data.error === "string") {
        errorMsg = data.error;
        return;
      }
      item = data as DetailItem;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (slug) void load();
  });

  /**
   * Rebase relative links/images in the README so they resolve against the
   * folder's raw GitHub URL. Without this, `./image.png` 404s and `[link](./other.md)`
   * lands in the playground app instead of GitHub.
   */
  function rebaseRelativeLinks(html: string, src: DetailItem["source"]): string {
    const rawBase = `https://raw.githubusercontent.com/${src.repo}/${src.ref}/${src.path}/`;
    const treeBase = `https://github.com/${src.repo}/tree/${src.ref}/${src.path}/`;
    return html
      .replace(/src="(?!https?:\/\/|data:|\/)/g, `src="${rawBase}`)
      .replace(/href="(?!https?:\/\/|#|\/|mailto:)/g, `href="${treeBase}`);
  }

  const renderedHtml = $derived.by(() => {
    if (!item || !item.readme) return "";
    const raw = markdownToHTML(item.readme);
    const rebased = rebaseRelativeLinks(raw, item.source);
    return DOMPurify.sanitize(rebased);
  });

  async function handleImport(): Promise<void> {
    // TODO: build/fetch the workspace zip from GitHub and POST to
    // /api/daemon/api/workspaces/import-bundle. Stubbed for now —
    // see "discover-page-zip-import" follow-up.
    importing = true;
    await new Promise((r) => setTimeout(r, 400));
    importing = false;
    toast({ title: "Import not yet wired — coming next" });
  }
</script>

<PageLayout.Root>
  <PageLayout.Breadcrumbs
    crumbs={[
      { label: "Discover Spaces", href: "/discover" },
      { label: item?.name ?? slug },
    ]}
  />
  <PageLayout.Body>
    <PageLayout.Content>
      {#if loading}
        <div class="loading">Loading…</div>
      {:else if errorMsg}
        <div class="error-banner" role="alert">
          <span>{errorMsg}</span>
          <button class="retry" onclick={() => void load()}>Retry</button>
        </div>
      {:else if item}
        <div class="detail-stack">
          <div class="detail-headerbar">
            <p class="meta">
              <a href={item.source.htmlUrl} target="_blank" rel="noopener noreferrer">
                <code>{item.source.repo}/{item.source.path}</code>
              </a>
            </p>
            <Button variant="primary" onclick={handleImport} disabled={importing}>
              {importing ? "Importing…" : "Import workspace"}
            </Button>
          </div>

          {#if item.signals.length > 0 || item.agents.length > 0 || item.jobs.length > 0}
            <section class="manifest">
              {#if item.signals.length > 0}
                <div class="manifest-group">
                  <h2 class="manifest-h">Signals <span class="count">{item.signals.length}</span></h2>
                  <ul class="manifest-list">
                    {#each item.signals as s (s.id)}
                      <li class="manifest-row">
                        <div class="row-main">
                          <code class="row-id">{s.id}</code>
                          {#if s.title}
                            <span class="row-title">{s.title}</span>
                          {/if}
                        </div>
                        {#if s.provider}
                          <span class="pill" data-kind={s.provider}>{s.provider}</span>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}

              {#if item.agents.length > 0}
                <div class="manifest-group">
                  <h2 class="manifest-h">Agents <span class="count">{item.agents.length}</span></h2>
                  <ul class="manifest-list">
                    {#each item.agents as a (a.id)}
                      <li class="manifest-row">
                        <div class="row-main">
                          <code class="row-id">{a.id}</code>
                          {#if a.description}
                            <span class="row-title">{a.description}</span>
                          {/if}
                        </div>
                        {#if a.type}
                          <span class="pill" data-kind={a.type}>{a.type}</span>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}

              {#if item.jobs.length > 0}
                <div class="manifest-group">
                  <h2 class="manifest-h">Jobs <span class="count">{item.jobs.length}</span></h2>
                  <ul class="manifest-list">
                    {#each item.jobs as j (j.id)}
                      <li class="manifest-row">
                        <div class="row-main">
                          <code class="row-id">{j.id}</code>
                          {#if j.title}
                            <span class="row-title">{j.title}</span>
                          {/if}
                        </div>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </section>
          {/if}

          {#if item.readme}
            <section class="readme">
              <MarkdownRendered>
                {@html renderedHtml}
              </MarkdownRendered>
            </section>
          {:else}
            <div class="empty">No README.md in this folder.</div>
          {/if}
        </div>
      {/if}
    </PageLayout.Content>
  </PageLayout.Body>
</PageLayout.Root>

<style>
  .detail-stack {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
  }

  .detail-headerbar {
    align-items: center;
    display: flex;
    gap: var(--size-4);
    justify-content: space-between;
  }

  .meta {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    display: flex;
    font-size: 12px;
    gap: 8px;
    margin: 0;
  }

  .meta a {
    color: inherit;
    text-decoration: none;
  }

  .meta code {
    background: var(--color-surface-3);
    border-radius: 4px;
    font-size: 12px;
    padding: 2px 8px;
  }

  .readme {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    padding: var(--size-6);
  }

  .manifest {
    display: flex;
    flex-direction: column;
    gap: var(--size-5);
  }

  .manifest-group {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    padding: var(--size-4) var(--size-5);
  }

  .manifest-h {
    align-items: baseline;
    color: var(--color-text);
    display: flex;
    font-size: 13px;
    font-weight: 600;
    gap: 8px;
    letter-spacing: 0.04em;
    margin: 0 0 var(--size-3);
    text-transform: uppercase;
  }

  .manifest-h .count {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-family: var(--font-family-monospace);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
  }

  .manifest-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .manifest-row {
    align-items: center;
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    gap: var(--size-3);
    justify-content: space-between;
    padding: var(--size-2) 0;
  }

  .manifest-row:first-child {
    border-block-start: none;
  }

  .row-main {
    align-items: center;
    display: flex;
    gap: var(--size-3);
    min-width: 0;
  }

  .row-id {
    background: var(--color-surface-3);
    border-radius: 4px;
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: 12px;
    padding: 2px 8px;
    white-space: nowrap;
  }

  .row-title {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pill {
    background: color-mix(in srgb, var(--color-text), transparent 90%);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 2px 8px;
    text-transform: uppercase;
  }

  .pill[data-kind="http"],
  .pill[data-kind="atlas"] {
    background: color-mix(in srgb, var(--color-accent, #1171df), transparent 85%);
    color: var(--color-accent, #1171df);
  }

  .pill[data-kind="schedule"],
  .pill[data-kind="user"] {
    background: color-mix(in srgb, #a855f7, transparent 85%);
    color: #a855f7;
  }

  .pill[data-kind="llm"] {
    background: color-mix(in srgb, #10b981, transparent 85%);
    color: #10b981;
  }

  .loading,
  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-size: 13px;
    padding: var(--size-6);
    text-align: center;
  }

  .error-banner {
    align-items: center;
    background: color-mix(in srgb, var(--color-error), transparent 85%);
    border: 1px solid color-mix(in srgb, var(--color-error), transparent 50%);
    border-radius: 6px;
    display: flex;
    gap: 12px;
    padding: 10px 14px;
  }

  .retry {
    background: transparent;
    border: 1px solid var(--color-border-2);
    border-radius: 4px;
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    margin-left: auto;
    padding: 3px 10px;
  }
</style>
