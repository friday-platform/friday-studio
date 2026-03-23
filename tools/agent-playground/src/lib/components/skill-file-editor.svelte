<!--
  CodeMirror editor for skill file content (SKILL.md or reference files).

  Mounts a markdown-highlighted editor with Cmd+S to save and Escape to cancel.
  Reports dirty state via callback so the parent can propagate to the tree.
  Exposes current editor content via bindable `editedContent` so the parent can
  trigger saves from external UI (e.g. a Save button in the header).

  @component
  @prop content - Initial file content to edit
  @prop editedContent - Bindable: current editor text, kept in sync as user types
  @prop onsave - Called with new content when user saves (Cmd+S)
  @prop oncancel - Called when user cancels (Escape)
  @prop ondirtychange - Called when dirty state changes
-->

<script lang="ts">
  import { basicSetup } from "codemirror";
  import { EditorView, keymap } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import { markdown } from "@codemirror/lang-markdown";
  import { atlasTheme } from "$lib/editor/atlas-theme";
  import { onDestroy } from "svelte";
  import { untrack } from "svelte";

  interface Props {
    content: string;
    editedContent?: string;
    onsave: (content: string) => void;
    oncancel: () => void;
    ondirtychange?: (dirty: boolean) => void;
  }

  let {
    content,
    editedContent = $bindable(""),
    onsave,
    oncancel,
    ondirtychange,
  }: Props = $props();

  let editorContainer: HTMLDivElement | undefined = $state();
  let editorView: EditorView | undefined;
  let currentContent = $state("");
  let initialContent = $state("");

  const dirty = $derived(currentContent !== initialContent);

  $effect(() => {
    editedContent = currentContent;
  });

  $effect(() => {
    ondirtychange?.(dirty);
  });

  function save() {
    if (!dirty) return;
    onsave(currentContent);
  }

  function cancel() {
    oncancel();
  }

  $effect(() => {
    if (!editorContainer || editorView) return;

    untrack(() => {
      initialContent = content;
      currentContent = content;

      const view = new EditorView({
        state: EditorState.create({
          doc: content,
          extensions: [
            basicSetup,
            markdown(),
            ...atlasTheme,
            keymap.of([
              {
                key: "Mod-s",
                run: () => {
                  save();
                  return true;
                },
              },
              {
                key: "Escape",
                run: () => {
                  cancel();
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
</script>

<div class="editor-container" bind:this={editorContainer}></div>

<style>
  .editor-container {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    flex: 1;
    overflow: hidden;
  }

  .editor-container :global(.cm-editor) {
    height: 100%;
  }
</style>
