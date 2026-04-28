<script lang="ts">
  import { Button, MarkdownRendered, markdownToHTML, PageLayout, toast } from "@atlas/ui";
  import { page } from "$app/state";
  import { getClient } from "$lib/client.ts";
  import DOMPurify from "dompurify";

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
    crumbs={[{ label: "Discover Spaces", href: "/discover" }, { label: item?.name ?? slug }]}
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
            <Button variant="secondary" onclick={handleImport} disabled={importing}>
              {importing ? "Importing…" : "Add Now"}
            </Button>

            <p class="meta">
              <a href={item.source.htmlUrl} target="_blank" rel="noopener noreferrer">
                View in GitHub
              </a>
            </p>
          </div>

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

    {#if item && (item.signals.length > 0 || item.agents.length > 0 || item.jobs.length > 0)}
      <PageLayout.Sidebar>
        <section class="manifest">
          {#if item.signals.length > 0}
            <div class="manifest-group">
              <h2 class="manifest-h">Signals</h2>
              <ul class="manifest-list">
                {#each item.signals as s (s.id)}
                  <li class="manifest-row">
                    <div class="row-main">
                      <code class="row-id">{s.id}</code>
                      {#if s.title}
                        <span class="row-title">{s.title}</span>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

          {#if item.agents.length > 0}
            <div class="manifest-group">
              <h2 class="manifest-h">Agents</h2>
              <ul class="manifest-list">
                {#each item.agents as a (a.id)}
                  <li class="manifest-row">
                    <div class="row-main">
                      <code class="row-id">{a.id}</code>
                      {#if a.description}
                        <span class="row-title">{a.description}</span>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

          {#if item.jobs.length > 0}
            <div class="manifest-group">
              <h2 class="manifest-h">Jobs</h2>
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
      </PageLayout.Sidebar>
    {/if}
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
    font-family: var(--font-family-monospace);
    font-size: 12px;
  }

  .readme {
    padding-block: var(--size-2);
  }

  .manifest {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
  }

  .manifest-group {
    padding-block: var(--size-2);
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

  .manifest-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .manifest-row {
    align-items: flex-start;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
  }

  .row-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .row-id {
    color: var(--color-text);
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
  }

  .row-title {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: 12px;
    line-height: 1.4;
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
