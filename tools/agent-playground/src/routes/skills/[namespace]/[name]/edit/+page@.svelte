<!--
  Full-page CodeMirror editor for raw SKILL.md content (global catalog, no workspace).

  Reconstructs the SKILL.md from stored fields, allows raw editing, and
  publishes back via the skills API on save.

  @component
-->

<script lang="ts">
  import { basicSetup } from "codemirror";
  import { EditorView, keymap } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import { yaml as yamlLang } from "@codemirror/lang-yaml";
  import { atlasTheme } from "$lib/editor/atlas-theme";
  import { Button } from "@atlas/ui";
  import { onDestroy } from "svelte";
  import { untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { useSkill } from "$lib/queries/skills";
  import { getDaemonClient } from "$lib/daemon-client.ts";
  import { stringify, parse } from "yaml";

  const namespace = $derived(page.params.namespace ?? "");
  const name = $derived(page.params.name ?? "");

  const skillQuery = useSkill(
    () => namespace,
    () => name,
  );

  const skill = $derived(skillQuery.data?.skill);
  const queryClient = useQueryClient();
  const client = getDaemonClient();

  let editorContainer: HTMLDivElement | undefined = $state();
  let editorView: EditorView | undefined;
  let initialSnapshot = $state("");
  let currentContent = $state("");
  let errorMessage = $state<string | null>(null);
  let saving = $state(false);

  const dirty = $derived(currentContent !== initialSnapshot);

  /**
   * Reconstruct a SKILL.md string from stored frontmatter + instructions.
   */
  function reconstructSkillMd(
    frontmatter: Record<string, unknown>,
    instructions: string,
    skillTitle: string | null,
    skillDescription: string,
    skillNamespace: string,
    skillName: string,
  ): string {
    const fm: Record<string, unknown> = {};
    fm.name = `${skillNamespace}/${skillName}`;
    fm.description = skillDescription;
    if (skillTitle) fm.title = skillTitle;

    for (const [key, value] of Object.entries(frontmatter)) {
      if (key === "name" || key === "description" || key === "title") continue;
      fm[key] = value;
    }

    const yamlStr = stringify(fm, { lineWidth: 0 }).trimEnd();
    return `---\n${yamlStr}\n---\n\n${instructions}`;
  }

  /**
   * Parse SKILL.md content into frontmatter and instructions.
   */
  function parseSkillMdClient(content: string): {
    frontmatter: Record<string, unknown>;
    instructions: string;
  } {
    if (!content.startsWith("---")) {
      return { frontmatter: {}, instructions: content.trim() };
    }

    const closingIndex = content.indexOf("\n---", 3);
    if (closingIndex === -1) {
      return { frontmatter: {}, instructions: content.trim() };
    }

    const raw = content.slice(4, closingIndex);
    const body = content.slice(closingIndex + 4);

    if (!raw.trim()) {
      return { frontmatter: {}, instructions: body.trim() };
    }

    const parsed: unknown = parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Frontmatter must be a YAML mapping");
    }

    return {
      frontmatter: parsed as Record<string, unknown>,
      instructions: body.trim(),
    };
  }

  async function save() {
    if (!dirty || !skill || saving) return;
    saving = true;
    errorMessage = null;

    try {
      const { frontmatter, instructions } = parseSkillMdClient(currentContent);

      const title = typeof frontmatter.title === "string" ? frontmatter.title : undefined;
      const description = typeof frontmatter.description === "string"
        ? frontmatter.description
        : skill.description;

      const { name: _n, description: _d, title: _t, ...remainingFrontmatter } = frontmatter;

      const res = await client.skills[":namespace"][":name"].$post({
        param: { namespace: `@${namespace}`, name },
        json: {
          title,
          description,
          instructions,
          frontmatter: remainingFrontmatter,
          descriptionManual: true,
        },
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(
          "error" in body && typeof body.error === "string"
            ? body.error
            : `Save failed: ${res.status}`,
        );
      }

      await queryClient.invalidateQueries({
        queryKey: ["daemon", "skills", namespace, name],
      });
      await queryClient.invalidateQueries({
        queryKey: ["daemon", "skills"],
      });
      initialSnapshot = currentContent;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  $effect(() => {
    if (!skill || !editorContainer || editorView) return;

    untrack(() => {
      const md = reconstructSkillMd(
        skill.frontmatter ?? {},
        skill.instructions ?? "",
        skill.title ?? null,
        skill.description ?? "",
        namespace,
        name,
      );
      initialSnapshot = md;
      currentContent = md;

      const view = new EditorView({
        state: EditorState.create({
          doc: md,
          extensions: [
            basicSetup,
            yamlLang(),
            ...atlasTheme,
            keymap.of([
              {
                key: "Mod-s",
                run: () => {
                  save();
                  return true;
                },
              },
            ]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                currentContent = update.state.doc.toString();
              }
            }),
          ],
        }),
        parent: editorContainer,
      });

      editorView = view;
    });
  });

  onDestroy(() => {
    editorView?.destroy();
    editorView = undefined;
  });

  $effect(() => {
    if (!dirty) return;

    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  });
</script>

<div class="edit-page">
  <a href="/skills/{namespace}/{name}" class="back-link">&larr; Back to skill</a>

  <div class="edit-content">
    <div class="title-row">
      <h1 class="edit-title">Edit @{namespace}/{name}</h1>
      <Button
        size="small"
        disabled={!dirty || saving}
        onclick={save}
      >
        {saving ? "Saving..." : "Save"}
      </Button>
    </div>

    {#if errorMessage}
      <div class="error-banner">
        <span class="error-text">{errorMessage}</span>
        <button class="error-dismiss" onclick={() => (errorMessage = null)}>
          &times;
        </button>
      </div>
    {/if}

    {#if skillQuery.isLoading}
      <div class="empty-state">Loading skill...</div>
    {:else if skillQuery.isError}
      <div class="empty-state">Failed to load skill: {skillQuery.error?.message}</div>
    {:else}
      <div class="editor-container" bind:this={editorContainer}></div>
    {/if}
  </div>
</div>

<style>
  .edit-page {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    height: 100%;
    overflow: hidden;
    padding: var(--size-8) var(--size-10);
  }

  .back-link {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
    text-decoration: none;
    width: fit-content;
  }

  .back-link:hover {
    color: var(--color-text);
  }

  .edit-content {
    display: flex;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
  }

  .title-row {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    justify-content: space-between;
    padding-block: var(--size-4) var(--size-5);
  }

  .edit-title {
    color: var(--color-text);
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-7);
    line-height: var(--font-lineheight-1);
    margin: 0;
  }

  .error-banner {
    align-items: center;
    background: color-mix(in srgb, var(--color-error), transparent 85%);
    border: 1px solid var(--color-error);
    border-radius: var(--radius-2);
    color: var(--color-text);
    display: flex;
    flex-shrink: 0;
    font-size: var(--font-size-2);
    gap: var(--size-3);
    margin-block-end: var(--size-3);
    padding: var(--size-2) var(--size-3);
  }

  .error-text {
    flex: 1;
    font-family: var(--font-family-monospace);
  }

  .error-dismiss {
    background: none;
    border: none;
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-4);
    line-height: 1;
    opacity: 0.6;
    padding: var(--size-1);
  }

  .error-dismiss:hover {
    opacity: 1;
  }

  .editor-container {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    flex: 1;
    overflow: hidden;
  }

  .editor-container :global(.cm-editor) {
    height: 100%;
  }

  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    display: flex;
    flex: 1;
    font-size: var(--font-size-3);
    justify-content: center;
  }
</style>
