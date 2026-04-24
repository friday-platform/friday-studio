<script lang="ts">
  import { EditorState, TextSelection } from "prosemirror-state";
  import { EditorView } from "prosemirror-view";
  import { untrack } from "svelte";
  import MarkdownRendered from "../primitives/markdown-rendered.svelte";
  import { parseMarkdown, serializeMarkdown } from "./markdown";
  import { tableNodeView } from "./node-views";
  import { buildPlugins } from "./plugins";
  import { editorSchema } from "./schema";
  import "prosemirror-view/style/prosemirror.css";

  let {
    value,
    onchange,
    onblur,
    disabled = false,
    placeholder = undefined,
    focus = $bindable(),
  }: {
    value: string;
    onchange?: (md: string) => void;
    onblur?: (md: string) => void;
    disabled?: boolean;
    placeholder?: string;
    focus?: () => void;
  } = $props();

  let view: EditorView | undefined;
  let isEmpty = $derived(!value);
  const plugins = buildPlugins(editorSchema);

  function mountEditor(el: HTMLElement) {
    const doc = untrack(() => parseMarkdown(value));

    view = new EditorView(el, {
      state: EditorState.create({ doc, plugins }),
      nodeViews: { table: tableNodeView },
      editable: () => !disabled,
      handleDOMEvents: {
        blur: () => {
          if (view) {
            onblur?.(serializeMarkdown(view.state.doc));
          }
          return false;
        },
      },
      dispatchTransaction(tr) {
        if (!view) return;
        const newState = view.state.apply(tr);
        view.updateState(newState);

        if (tr.docChanged) {
          const md = serializeMarkdown(newState.doc);
          isEmpty = !md.trim();
          onchange?.(md);
        }
      },
    });

    focus = () => {
      if (!view) return;
      const tr = view.state.tr.setSelection(TextSelection.atStart(view.state.doc));
      view.dispatch(tr);
      view.focus();
    };

    return () => {
      view?.destroy();
      view = undefined;
    };
  }
</script>

<MarkdownRendered>
  <div class="markdown-editor" {@attach mountEditor}>
    {#if placeholder && isEmpty}
      <span class="placeholder">{placeholder}</span>
    {/if}
  </div>
</MarkdownRendered>

<style>
  .markdown-editor {
    position: relative;
  }

  .placeholder {
    color: var(--color-text);
    font-size: var(--font-size-4);
    left: 0;
    opacity: 0.6;
    pointer-events: none;
    position: absolute;
    top: 0;
  }

  .markdown-editor :global(.ProseMirror) {
    min-block-size: 12rem;
    outline: none;
  }

  .markdown-editor :global(.ProseMirror:focus) {
    outline: none;
  }

  /* Editor-specific table overrides */
  .markdown-editor :global(:where(table)) {
    margin-block: var(--size-6) 0;

    &:global(.ProseMirror-selectednode) {
      outline: 2px solid var(--accent-2);
      outline-offset: 2px;
      border-radius: var(--radius-3);
    }
  }
</style>
