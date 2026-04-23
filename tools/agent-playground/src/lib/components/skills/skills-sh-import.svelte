<!--
  Import a skill directly from skills.sh.

  Given the context (global /skills catalog), the import doesn't auto-assign
  to a workspace — the user attaches it afterwards from the workspace-scoped
  page. Autocomplete over the skills.sh search endpoint mirrors the
  per-workspace install input; once a result is picked the form submits
  straight to `POST /api/skills/install`.

  @component
-->
<script lang="ts">
  import { createQuery, queryOptions, skipToken } from "@tanstack/svelte-query";
  import { toast } from "@atlas/ui";
  import { goto } from "$app/navigation";
  import { z } from "zod";
  import { searchSkillsSh, useInstallSkill } from "$lib/queries/skills";

  interface Props {
    onclose?: () => void;
    /** When set, the imported skill is auto-assigned to this workspace. */
    workspaceId?: string;
  }

  const { onclose, workspaceId }: Props = $props();

  const installMut = useInstallSkill();

  let source = $state("");
  let focused = $state(false);
  let searchQuery = $state("");
  let searchDebounce: ReturnType<typeof setTimeout> | undefined;

  function handleInput(e: Event): void {
    const target = e.currentTarget;
    if (!(target instanceof HTMLInputElement)) return;
    const v = target.value;
    source = v;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = v.trim();
    }, 200);
  }

  const suggestionsQuery = createQuery(() =>
    queryOptions({
      queryKey: ["skillssh-search", searchQuery] as const,
      queryFn:
        searchQuery.length >= 2 && searchQuery.split("/").filter(Boolean).length < 3
          ? () => searchSkillsSh(searchQuery, 8)
          : skipToken,
      staleTime: 60_000,
    }),
  );
  const suggestions = $derived(suggestionsQuery.data?.skills ?? []);
  const showSuggestions = $derived(
    focused && source.trim().length >= 2 && suggestions.length > 0,
  );

  function pickSuggestion(id: string): void {
    source = id;
    searchQuery = id;
    focused = false;
  }

  const PublishedSchema = z.object({
    published: z
      .object({
        namespace: z.string(),
        name: z.string(),
        version: z.number(),
      })
      .optional(),
  });

  async function doInstall(): Promise<void> {
    const src = source.trim();
    if (!src) return;
    try {
      const res = await installMut.mutateAsync(
        workspaceId ? { source: src, workspaceId } : { source: src },
      );
      const parsed = PublishedSchema.safeParse(res);
      const published = parsed.success ? parsed.data.published : undefined;
      const ref = published ? `@${published.namespace}/${published.name}` : src;
      toast({
        title: "Skill imported",
        description: workspaceId
          ? `${ref} — assigned to this workspace.`
          : `${ref} added to the global catalog.`,
      });
      onclose?.();
      if (published && !workspaceId) {
        goto(`/skills/${published.namespace}/${published.name}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "Import failed", description: message, error: true });
    }
  }
</script>

<div class="import">
  <div class="input-row">
    <input
      type="text"
      placeholder="owner/repo/slug (e.g. anthropics/skills/pdf)"
      value={source}
      oninput={handleInput}
      onfocus={() => {
        focused = true;
      }}
      onblur={() => setTimeout(() => (focused = false), 150)}
      autocomplete="off"
    />
    {#if showSuggestions}
      <ul class="suggestions">
        {#each suggestions as s (s.id)}
          <li>
            <button
              type="button"
              class="sugg"
              onmousedown={(e) => {
                e.preventDefault();
                pickSuggestion(s.id);
              }}
            >
              <span class="sugg-name">{s.name}</span>
              <span class="sugg-src">{s.source}</span>
              <span class="sugg-meta">
                <span class="tier-tag tier-{s.tier}">{s.tier}</span>
                <span class="installs">{s.installs.toLocaleString()} installs</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  <button
    type="button"
    class="install-btn"
    disabled={installMut.isPending || source.trim().length === 0}
    onclick={doInstall}
  >
    {installMut.isPending ? "Importing…" : "Import skill"}
  </button>
  <p class="hint">
    Type a skill name to search, or paste <code>owner/repo/slug</code> directly. Browse all at{" "}
    <a href="https://skills.sh" target="_blank" rel="noopener noreferrer">skills.sh ↗</a>
  </p>
</div>

<style>
  .import {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    inline-size: min(540px, 100%);
    text-align: start;
  }

  .input-row {
    position: relative;
  }

  input {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: inherit;
    font-size: var(--font-size-2);
    inline-size: 100%;
    padding: var(--size-2) var(--size-3);
  }

  input:focus {
    border-color: color-mix(in srgb, var(--color-text), transparent 40%);
    outline: none;
  }

  .suggestions {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    box-shadow: var(--shadow-1);
    display: flex;
    flex-direction: column;
    inset-block-start: calc(100% + var(--size-1));
    inset-inline: 0;
    list-style: none;
    margin: 0;
    max-block-size: 280px;
    overflow-y: auto;
    padding: var(--size-1);
    position: absolute;
    z-index: 10;
  }

  .sugg {
    background: transparent;
    border: none;
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    display: grid;
    gap: var(--size-1);
    grid-template-columns: auto 1fr auto;
    inline-size: 100%;
    padding: var(--size-2);
    text-align: start;
  }

  .sugg:hover {
    background-color: var(--color-surface-2);
  }

  .sugg-name {
    font-weight: var(--font-weight-6);
  }

  .sugg-src {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sugg-meta {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .tier-tag {
    border-radius: var(--radius-1);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.04em;
    padding: 1px var(--size-1);
    text-transform: uppercase;
  }

  /* OFFICIAL — green, signals a trusted/curated source. */
  .tier-official {
    background-color: color-mix(in oklch, var(--color-success, #238636), transparent 80%);
    color: color-mix(in oklch, var(--color-success, #238636), var(--color-text) 40%);
  }

  /* COMMUNITY — blue, signals user-contributed. Distinct from official. */
  .tier-community {
    background-color: color-mix(in oklch, var(--color-accent-blue, #1f6feb), transparent 80%);
    color: color-mix(in oklch, var(--color-accent-blue, #1f6feb), var(--color-text) 40%);
  }

  .installs {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
  }

  .install-btn {
    background-color: var(--color-text);
    border: none;
    border-radius: var(--radius-2);
    color: var(--color-surface-1);
    cursor: pointer;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    padding: var(--size-2) var(--size-3);
  }

  .install-btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .hint {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-1);
    margin: 0;
  }

  code {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-1);
    font-family: var(--font-mono, monospace);
    padding: 1px var(--size-1);
  }

  a {
    color: var(--color-text);
  }
</style>
