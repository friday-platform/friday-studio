<script lang="ts">
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { beforeNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { IconSmall } from "$lib/components/icons/small";
  import { MarkdownEditor } from "$lib/components/markdown-editor";
  import { Page } from "$lib/components/page";
  import { featureFlags } from "$lib/feature-flags";
  import { deleteSkill, disableSkill, getSkillById, publishSkill } from "$lib/queries/skills";
  import { toSlug } from "$lib/utils/slug";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const appCtx = getAppContext();
  const queryClient = useQueryClient();

  const queryKey = $derived(["skill", page.params.skillId]);

  const skillQuery = createQuery(() => ({
    queryKey: queryKey,
    queryFn: () => getSkillById(page.params.skillId),
    initialData: data.initialSkill,
    select: (data) => data.skill,
    staleTime: Infinity,
  }));

  const skill = $derived(skillQuery.data);

  let draft = $derived({
    title: skill?.title ?? "",
    instructions: skill?.instructions ?? "",
    slug: skill?.name ?? "",
    description: skill?.description ?? "",
    descriptionManual: skill?.descriptionManual ?? false,
  });

  let descriptionMirror: HTMLParagraphElement | null = $state(null);
  let descriptionTextarea: HTMLTextAreaElement | null = $state(null);
  let focusEditor: (() => void) | undefined = $state();

  $effect(() => {
    resizeDescription(draft.description);
  });

  function resizeDescription(_value?: string | null) {
    if (!descriptionTextarea || !descriptionMirror) return;
    descriptionMirror.innerHTML = `${descriptionTextarea.value} <br />`;
    descriptionTextarea.style.height = `${descriptionMirror.getBoundingClientRect().height}px`;
  }

  function isDirty(): boolean {
    if (!skill) return false;
    return (
      draft.title !== (skill.title ?? "") ||
      draft.instructions !== skill.instructions ||
      draft.slug !== (skill.name ?? "") ||
      draft.description !== skill.description ||
      draft.descriptionManual !== skill.descriptionManual
    );
  }

  const publishMut = createMutation(() => ({
    mutationFn: (input: {
      title: string;
      instructions: string;
      slug: string;
      description: string;
      descriptionManual: boolean;
    }) =>
      publishSkill(skill!.namespace, input.slug, {
        title: input.title || undefined,
        description: input.description || undefined,
        instructions: input.instructions,
        skillId: skill!.skillId,
        descriptionManual: input.descriptionManual,
      }),
    onSuccess: (published, saved) => {
      // Update cache to match saved values — avoids refetch race that wipes draft
      queryClient.setQueryData(queryKey, (old: typeof data.initialSkill | undefined) => {
        if (!old) return old;
        return {
          skill: {
            ...old.skill,
            version: published.version,
            name: saved.slug || old.skill.name,
            title: saved.title || null,
            instructions: saved.instructions,
            description: saved.description,
            descriptionManual: saved.descriptionManual,
          },
        };
      });
      queryClient.invalidateQueries({ queryKey: ["skills"] });

      if (!skill || saved.slug === (skill.name ?? "")) return;
      goto(appCtx.routes.skills.item(skill.skillId, skill.namespace, saved.slug), {
        replaceState: true,
        keepFocus: true,
      });
    },
  }));

  const disableMut = createMutation(() => ({
    mutationFn: (disabled: boolean) => disableSkill(skill!.skillId, disabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      queryClient.invalidateQueries({ queryKey: queryKey });
    },
  }));

  const deleteMut = createMutation(() => ({
    mutationFn: () => deleteSkill(skill!.skillId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      goto(appCtx.routes.skills.list);
    },
  }));

  function save() {
    if (!skill || publishMut.isPending) return;

    const resolvedSlug = draft.slug || (draft.title ? toSlug(draft.title) : "");
    if (!resolvedSlug) return;

    draft.slug = resolvedSlug;

    publishMut.mutate({
      title: draft.title,
      instructions: draft.instructions,
      slug: resolvedSlug,
      description: draft.description,
      descriptionManual: draft.descriptionManual,
    });
  }

  function handleDescriptionInput() {
    if (!draft.descriptionManual) draft.descriptionManual = true;
    if (!draft.description.trim()) draft.descriptionManual = false;
    markEdited();
  }

  function saveIfDirty() {
    if (isDirty()) save();
  }

  let lastEditAt = $state(Date.now());

  function markEdited() {
    lastEditAt = Date.now();
  }

  $effect(() => {
    void lastEditAt;
    const interval = setInterval(() => {
      if (isDirty()) save();
    }, 3000);
    return () => clearInterval(interval);
  });

  beforeNavigate(() => {
    if (isDirty()) save();
  });
</script>

<Page.Root>
  <Page.Content>
    {#snippet prepend()}
      <Breadcrumbs.Root fixed>
        <Breadcrumbs.Item href={appCtx.routes.skills.list} showCaret>
          {#snippet prepend()}
            <span style:color="var(--blue-2)">
              <IconSmall.Skills />
            </span>
          {/snippet}
          Skills
        </Breadcrumbs.Item>
      </Breadcrumbs.Root>
    {/snippet}

    {#snippet header()}
      <Page.Title
        value={draft.title}
        placeholder="Title..."
        onsubmit={() => focusEditor?.()}
        onchange={(v) => {
          draft.title = v;
          markEdited();
        }}
        onblur={saveIfDirty}
      />
    {/snippet}
    <div class="editor">
      <MarkdownEditor
        value={draft.instructions}
        onchange={(v) => {
          draft.instructions = v;
          markEdited();
        }}
        onblur={saveIfDirty}
        placeholder="Write your instructions here, markdown syntax supported..."
        bind:focus={focusEditor}
      />
    </div>
  </Page.Content>
  <Page.Sidebar>
    <div class="actions">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <span class="action-trigger">
            Actions

            <IconSmall.CaretDown />
          </span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <DropdownMenu.Item
            onclick={() => disableMut.mutate(!skill?.disabled)}
            disabled={!skill.name || !skill.description}
            closeOnClick={false}
          >
            {skill?.disabled || !skill.name || !skill.description ? "Enable" : "Disable"}
          </DropdownMenu.Item>
          <DropdownMenu.Item onclick={() => deleteMut.mutate()}>Remove</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>

    <div class="section">
      <h2>Name</h2>
      <input
        class="slug-input"
        bind:value={draft.slug}
        placeholder="skill-name"
        oninput={markEdited}
        onblur={saveIfDirty}
      />
    </div>

    <div class="section">
      <h2>Description</h2>
      <div class="description-wrap">
        <p class="description-mirror" bind:this={descriptionMirror}>
          {draft.description}
          <br />
        </p>
        <textarea
          class="description"
          bind:this={descriptionTextarea}
          bind:value={draft.description}
          placeholder="Add a description..."
          oninput={handleDescriptionInput}
          onblur={saveIfDirty}
        ></textarea>
      </div>
    </div>

    {#if featureFlags.ENABLE_SKILL_ASSETS}
      <div class="section">
        <h2>Assets</h2>
        <span class="empty">Upload assets for this skill</span>
        <button>Upload</button>
      </div>
    {/if}

    {#if featureFlags.ENABLE_SKILL_REFERENCES}
      <div class="section">
        <h2>References</h2>
        <span class="empty">Upload additional references for this skill</span>
        <button>Upload</button>
      </div>
    {/if}
  </Page.Sidebar>
</Page.Root>

<style>
  .editor {
    cursor: text;
    margin-block: calc(-1 * var(--size-3)) 0;
  }

  .actions {
    align-items: center;
    display: flex;
    justify-content: start;
    margin: calc(-1 * var(--size-5));
    margin-block-end: 0;

    .action-trigger {
      align-items: center;
      display: flex;
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
      gap: var(--size-1);
      opacity: 0.6;
    }
  }

  .section {
    h2 {
      font-size: var(--font-size-4);
      font-weight: var(--font-weight-5);
      line-height: var(--font-lineheight-1);
      margin-block: 0 var(--size-1);
      opacity: 0.8;
    }

    .description-wrap {
      position: relative;
      width: 100%;
    }

    .description-mirror,
    .description {
      font-family: inherit;
      font-size: inherit;
      font-weight: var(--font-weight-4);
      line-height: var(--font-lineheight-2);
      word-break: break-word;
    }

    .description-mirror {
      opacity: 0;
      pointer-events: none;
      position: absolute;
      inset-block-start: 0;
      inset-inline-start: 0;
      white-space: pre-wrap;
    }

    .description {
      background: none;
      border: none;
      color: inherit;
      display: block;
      opacity: 0.6;
      outline: none;
      padding: 0;
      resize: none;
      width: 100%;

      &::placeholder {
        color: var(--color-text);
        opacity: 1;
      }
    }

    .slug-input {
      background: none;
      border: none;
      color: inherit;
      font-family: inherit;
      font-size: inherit;
      font-weight: var(--font-weight-4);
      line-height: var(--font-lineheight-2);
      opacity: 0.6;
      outline: none;
      padding: 0;
      width: 100%;
      word-break: break-word;
    }

    .empty {
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-4);
      line-height: var(--font-lineheight-1);
      opacity: 0.6;
    }

    button {
      display: block;
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
      line-height: var(--font-lineheight-1);
      margin-block: var(--size-2-5) 0;
      opacity: 0.8;
      text-decoration-line: underline;
    }
  }
</style>
