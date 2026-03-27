<script lang="ts">
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { beforeNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import { Dialog } from "$lib/components/dialog";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { IconSmall } from "$lib/components/icons/small";
  import { MarkdownEditor } from "$lib/components/markdown-editor";
  import { Page } from "$lib/components/page";
  import Textarea from "$lib/components/textarea.svelte";
  import { deleteSkill, disableSkill, getSkillById, publishSkill } from "$lib/queries/skills";
  import { enforceKebabCase } from "$lib/utils/slug";
  import { onMount } from "svelte";
  import { toStore } from "svelte/store";
  import type { PageData } from "./$types";
  import {
    isDirty,
    resolveDescriptionManual,
    shouldInterceptNavigation,
  } from "./skill-page-helpers.ts";

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

  let draft = $state({
    instructions: skill?.instructions ?? "",
    slug: skill?.name ?? "",
    description: skill?.description ?? "",
    descriptionManual: skill?.descriptionManual ?? false,
  });

  // Sync draft when skill data loads/changes from server
  $effect(() => {
    if (!skill) return;
    draft.instructions = skill.instructions ?? "";
    draft.slug = skill.name ?? "";
    draft.description = skill.description ?? "";
    draft.descriptionManual = skill.descriptionManual ?? false;
  });

  let deleteDialogOpen = $state(false);

  function checkDirty(): boolean {
    return isDirty(draft, skill);
  }

  // Track pending navigation destination for save-then-navigate
  let pendingNavigationUrl: URL | null = $state(null);

  const publishMut = createMutation(() => ({
    mutationFn: (input: {
      instructions: string;
      slug: string;
      description: string;
      descriptionManual: boolean;
    }) => {
      if (!skill) throw new Error("Cannot publish: skill not loaded");
      return publishSkill(input.slug, {
        description: input.description || undefined,
        instructions: input.instructions,
        skillId: skill.skillId,
        descriptionManual: input.descriptionManual,
      });
    },
    onSuccess: (published, saved) => {
      // Update cache to match saved values — avoids refetch race that wipes draft
      queryClient.setQueryData(queryKey, (old: typeof data.initialSkill | undefined) => {
        if (!old) return old;
        return {
          skill: {
            ...old.skill,
            version: published.version,
            name: saved.slug || old.skill.name,
            instructions: saved.instructions,
            description: saved.description,
            descriptionManual: saved.descriptionManual,
          },
        };
      });
      queryClient.invalidateQueries({ queryKey: ["skills"] });

      // Complete pending navigation if one was deferred
      if (pendingNavigationUrl) {
        const url = pendingNavigationUrl;
        pendingNavigationUrl = null;
        goto(url);
        return;
      }

      if (!skill || saved.slug === (skill.name ?? "")) return;
      goto(appCtx.routes.skills.item(skill.skillId, saved.slug), {
        replaceState: true,
        keepFocus: true,
      });
    },
    onError: () => {
      pendingNavigationUrl = null;
    },
  }));

  const disableMut = createMutation(() => ({
    mutationFn: (disabled: boolean) => {
      if (!skill) throw new Error("Cannot toggle: skill not loaded");
      return disableSkill(skill.skillId, disabled);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      queryClient.invalidateQueries({ queryKey: queryKey });
    },
  }));

  const deleteMut = createMutation(() => ({
    mutationFn: () => {
      if (!skill) throw new Error("Cannot delete: skill not loaded");
      return deleteSkill(skill.skillId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      goto(appCtx.routes.skills.list);
    },
  }));

  function save() {
    if (!skill || publishMut.isPending) return;

    const resolvedSlug = draft.slug;
    if (!resolvedSlug) return;

    publishMut.mutate({
      instructions: draft.instructions,
      slug: resolvedSlug,
      description: draft.description,
      descriptionManual: draft.descriptionManual,
    });
  }

  function handleNameInput(event: Event & { currentTarget: HTMLInputElement }) {
    const input = event.currentTarget;
    const pos = input.selectionStart ?? 0;
    const raw = input.value;
    const sanitized = enforceKebabCase(raw);
    draft.slug = sanitized;
    input.value = sanitized;
    const diff = raw.length - sanitized.length;
    input.setSelectionRange(pos - diff, pos - diff);
    markEdited();
  }

  function handleDescriptionInput() {
    draft.descriptionManual = resolveDescriptionManual(draft.descriptionManual, draft.description);
    markEdited();
  }

  function saveIfDirty() {
    if (checkDirty()) save();
  }

  let lastEditAt = $state(Date.now());

  function markEdited() {
    lastEditAt = Date.now();
  }

  $effect(() => {
    void lastEditAt;
    const interval = setInterval(() => {
      if (checkDirty()) save();
    }, 3000);
    return () => clearInterval(interval);
  });

  // Save-on-navigate: cancel navigation, save, then navigate in onSuccess
  beforeNavigate((navigation) => {
    if (!shouldInterceptNavigation(navigation.type, checkDirty())) return;

    navigation.cancel();
    pendingNavigationUrl = navigation.to?.url ?? null;
    save();
  });

  // Safety net for hard browser navigation (tab close, URL bar change)
  onMount(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (checkDirty()) {
        e.preventDefault();
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
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
        <div class="prepend-spacer"></div>
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
                disabled={!skill?.name || !skill?.description}
                closeOnClick={false}
              >
                {skill?.disabled || !skill?.name || !skill?.description ? "Enable" : "Disable"}
              </DropdownMenu.Item>
              <DropdownMenu.Item onclick={() => (deleteDialogOpen = true)}>
                Remove
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
      </Breadcrumbs.Root>
    {/snippet}

    <div class="editor">
      <div class="header-area">
        <input
          class="name-input"
          value={draft.slug}
          placeholder="skill-name"
          maxlength={64}
          oninput={handleNameInput}
          onblur={saveIfDirty}
        />
        <Textarea
          bind:value={draft.description}
          placeholder="Description here..."
          oninput={handleDescriptionInput}
          onblur={saveIfDirty}
        />
      </div>

      <div class="editor-section">
        <MarkdownEditor
          value={draft.instructions}
          onchange={(v) => {
            draft.instructions = v;
            markEdited();
          }}
          onblur={saveIfDirty}
          placeholder="Write your instructions here, markdown syntax supported..."
        />
      </div>
    </div>
  </Page.Content>
</Page.Root>

<Dialog.Root
  open={toStore(
    () => deleteDialogOpen,
    (value) => {
      deleteDialogOpen = value;
    },
  )}
>
  {#snippet children(_open)}
    <Dialog.Content>
      <Dialog.Close />
      {#snippet header()}
        <Dialog.Title>Remove skill</Dialog.Title>
        <Dialog.Description>
          <p>
            This skill will be permanently removed. Any agents using this skill will no longer have
            access to it.
          </p>
        </Dialog.Description>
      {/snippet}

      {#snippet footer()}
        <Dialog.Button onclick={() => deleteMut.mutate()}>Remove Skill</Dialog.Button>
        <Dialog.Cancel>Cancel</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<style>
  .editor {
    inline-size: 100%;
    margin-inline: auto;
    max-inline-size: var(--size-216);
  }

  .prepend-spacer {
    flex: 1;
  }

  .actions {
    .action-trigger {
      align-items: center;
      display: flex;
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
      gap: var(--size-1);
      opacity: 0.6;
    }
  }

  .header-area {
    border-block-end: 1px solid var(--color-border-1);
    margin-block-end: var(--size-10);
    padding-block-end: var(--size-10);

    :global(textarea),
    :global(p) {
      font-size: var(--font-size-5);
      font-weight: var(--font-weight-5);
      inline-size: 100%;
      line-height: var(--font-lineheight-3);
      margin-block: 0;
      min-block-size: unset;
      padding-block: 0;
    }

    :global(textarea) {
      margin-block-start: var(--size-1-5);
      opacity: 0.6;
    }

    :global(textarea),
    :global(p) {
      max-inline-size: 80ch;
    }
  }

  .name-input {
    background: none;
    border: none;
    color: inherit;
    font-family: inherit;
    font-size: var(--font-size-8);
    font-weight: var(--font-weight-6);
    line-height: var(--font-lineheight-2);
    outline: none;
    padding: 0;
    width: 100%;
    word-break: break-word;
  }

  .editor-section {
    cursor: text;
  }
</style>
