<!--
  Full-page CodeMirror YAML editor for workspace configuration.

  Loads current config, serializes to YAML, and provides save-back
  to the daemon with dirty tracking, Cmd+S keybinding, and navigate-away guards.

  @component
-->

<script lang="ts">
  import { Button } from "@atlas/ui";
  import { yaml as yamlLang } from "@codemirror/lang-yaml";
  import { EditorState, StateEffect, StateField } from "@codemirror/state";
  import { Decoration, EditorView, keymap } from "@codemirror/view";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import WorkspaceBreadcrumb from "$lib/components/workspace/workspace-breadcrumb.svelte";
  import { getDaemonClient } from "$lib/daemon-client.ts";
  import { atlasTheme } from "$lib/editor/atlas-theme";
  import { workspaceQueries } from "$lib/queries";
  import { basicSetup } from "codemirror";
  import { onDestroy, untrack } from "svelte";
  import { isNode, parse, parseDocument, stringify } from "yaml";

  const workspaceId = $derived(page.params.workspaceId ?? null);
  const configQuery = createQuery(() => workspaceQueries.config(workspaceId));
  const queryClient = useQueryClient();
  const client = getDaemonClient();

  // Line highlight effect for jump-to-path — shows a flash on the target line
  const highlightLineEffect = StateEffect.define<number>();
  const clearHighlightEffect = StateEffect.define();
  const highlightLineMark = Decoration.line({ class: "cm-highlighted-line" });

  const highlightLineField = StateField.define({
    create: () => Decoration.none,
    update(decorations, tr) {
      for (const effect of tr.effects) {
        if (effect.is(highlightLineEffect)) {
          const line = tr.state.doc.lineAt(effect.value);
          return Decoration.set([highlightLineMark.range(line.from)]);
        }
        if (effect.is(clearHighlightEffect)) {
          return Decoration.none;
        }
      }
      return decorations;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  let editorContainer: HTMLDivElement | undefined = $state();
  let editorView: EditorView | undefined;
  let initialSnapshot = $state("");
  let currentContent = $state("");
  let errorMessage = $state<string | null>(null);
  let saving = $state(false);

  const dirty = $derived(currentContent !== initialSnapshot);

  async function save() {
    if (!dirty || !workspaceId || saving) return;
    saving = true;
    errorMessage = null;

    try {
      const parsed: unknown = parse(currentContent);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("YAML must be an object");
      }

      // Safe: guarded above — parsed is a non-null, non-array object
      const config: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));

      const res = await client.workspace[":workspaceId"].update.$post({
        param: { workspaceId },
        json: { config, backup: true },
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
        queryKey: workspaceQueries.config(workspaceId!).queryKey,
      });
      initialSnapshot = currentContent;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  // Wait for async data, then create editor once outside reactive tracking.
  // Follows codemirror wrapper pattern: create in onMount-like context,
  // use untrack to avoid dependency loops with $state writes.
  $effect(() => {
    const config = configQuery.data?.config;
    if (!config || !editorContainer || editorView) return;

    untrack(() => {
      const yamlStr = stringify(config, { lineWidth: 0 });
      initialSnapshot = yamlStr;
      currentContent = yamlStr;

      const view = new EditorView({
        state: EditorState.create({
          doc: yamlStr,
          extensions: [
            basicSetup,
            yamlLang(),
            ...atlasTheme,
            highlightLineField,
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

      // Jump to YAML path from ?path= query param (e.g. ?path=agents.gh)
      const targetPath = new URL(window.location.href).searchParams.get("path");
      if (targetPath) {
        const doc = parseDocument(yamlStr);
        const segments = targetPath.split(".");
        const node = doc.getIn(segments, true);
        if (isNode(node) && Array.isArray(node.range)) {
          const offset = node.range[0];
          const line = view.state.doc.lineAt(offset);
          requestAnimationFrame(() => {
            view.dispatch({
              selection: { anchor: line.from },
              scrollIntoView: true,
              effects: highlightLineEffect.of(line.from),
            });
            view.focus();
            // Fade out the highlight after 2s
            setTimeout(() => {
              view.dispatch({ effects: clearHighlightEffect.of(null) });
            }, 2000);
          });
        }
      }
    });
  });

  onDestroy(() => {
    editorView?.destroy();
    editorView = undefined;
  });

  // beforeunload guard
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
  {#if workspaceId}
    <WorkspaceBreadcrumb {workspaceId} />
  {/if}

  <div class="edit-content">
    <div class="title-row">
      <h1 class="edit-title">Edit Configuration</h1>
      <Button size="small" disabled={!dirty || saving} onclick={save}>
        {saving ? "Saving..." : "Save"}
      </Button>
    </div>

    {#if errorMessage}
      <div class="error-banner">
        <span class="error-text">{errorMessage}</span>
        <button class="error-dismiss" onclick={() => (errorMessage = null)}>&times;</button>
      </div>
    {/if}

    {#if configQuery.isLoading}
      <div class="empty-state">Loading workspace config...</div>
    {:else if configQuery.isError}
      <div class="empty-state">Failed to load config: {configQuery.error?.message}</div>
    {:else}
      <div class="editor-container" bind:this={editorContainer}></div>
    {/if}
  </div>
</div>

<style>
  .edit-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    padding: var(--size-8) var(--size-10) 0;
  }

  /* ── Content area ── */

  .edit-content {
    display: flex;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
    padding-inline: calc(3 * var(--size-10));
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

  /* ── Error banner ── */

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

  /* ── Editor ── */

  .editor-container {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    flex: 1;
    overflow: hidden;
  }

  .editor-container :global(.cm-editor) {
    height: 100%;
  }

  .editor-container :global(.cm-highlighted-line) {
    background-color: color-mix(in srgb, var(--color-info), transparent 85%);
    transition: background-color 500ms ease;
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
