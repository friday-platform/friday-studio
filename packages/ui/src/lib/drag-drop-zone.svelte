<!--
  Element-scoped file drop zone.

  Wraps a region with dragenter/over/leave/drop handlers and exposes a
  live `dragOver` flag through the children snippet. The wrapping
  `<div>` defaults to `display: contents` so it adds drop listeners
  without introducing a layout box — children keep their existing
  layout, positioning, and scoped-CSS context. Override with `class`
  or `style` if a real layout box is needed.

  Callers that overlay absolutely-positioned children inside the zone
  must set `position: relative` on the child themselves — `display:
  contents` on the wrapper removes it as a containing block, so the
  overlay would otherwise anchor to the nearest positioned ancestor
  outside the zone.

  Multiple zones can coexist on the same page; each is scoped to its
  own subtree, so a drop on one never fires the other.

  `onFiles` is read through the props proxy on every drop, so callers
  can pass a fresh arrow each render without losing the latest closure.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { createDragDropState } from "./drag-drop.svelte.ts";

  interface Props {
    /** Called with dropped files. Filtering is the caller's job. */
    onFiles: (files: File[]) => void;
    /** Optional class on the wrapper element. */
    class?: string;
    /** Inline style override. Appended after the default `display: contents`. */
    style?: string;
    /** Children receive the live `dragOver` state. */
    children: Snippet<[{ dragOver: boolean }]>;
  }

  const props: Props = $props();
  const state = createDragDropState((files) => props.onFiles(files));
</script>

<div
  class={props.class}
  style="display: contents;{props.style ? ` ${props.style}` : ''}"
  ondragenter={state.onDragEnter}
  ondragover={state.onDragOver}
  ondragleave={state.onDragLeave}
  ondrop={state.onDrop}
  role="presentation"
>
  {@render props.children({ dragOver: state.dragOver })}
</div>
