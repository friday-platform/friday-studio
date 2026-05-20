/**
 * Global drag-and-drop file context.
 *
 * Owns body-level dragenter/dragover/dragleave/drop listeners. Consumers
 * register an `onFiles` callback; the top of the stack receives drops.
 * Listeners attach lazily — present only while at least one handler is
 * registered — so navigating off a drop-enabled route leaves the document
 * inert. Lifecycle drives gating: a route component that wants drops
 * registers in a `$effect`; unmounting disposes automatically.
 *
 * Filtering (image-only, size limits, MIME checks, etc.) is the call
 * site's job — the context forwards every dropped file as a `File[]`.
 *
 * @module
 */

import { getContext, setContext } from "svelte";

const CONTEXT_KEY = Symbol("drag-drop-context");

export interface DragDropHandler {
  onFiles: (files: File[]) => void;
}

export interface DragDropContext {
  /** True while a file drag is hovering anywhere in the document. */
  readonly dragOver: boolean;
  /**
   * Push a handler onto the stack. Top of the stack receives drops.
   * Returns a disposer; call it (or return it from a `$effect`) to pop.
   */
  register(handler: DragDropHandler): () => void;
}

export function createDragDropContext(): DragDropContext {
  const handlers: DragDropHandler[] = [];
  let dragOver = $state(false);
  let attached = false;
  // Counter for nested dragenter/leave events. Dragging over a child
  // element fires dragleave on the parent and dragenter on the child;
  // a counter that increments on enter and decrements on leave only
  // returns to zero when the cursor exits the document entirely.
  let dragCounter = 0;

  function activeHandler(): DragDropHandler | null {
    return handlers[handlers.length - 1] ?? null;
  }

  function hasFiles(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (const t of types) {
      if (t === "Files") return true;
    }
    return false;
  }

  function onEnter(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounter++;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    dragOver = true;
  }

  function onOver(e: DragEvent) {
    if (!hasFiles(e)) return;
    // preventDefault on dragover is REQUIRED — without it the browser
    // rejects the drop and `drop` never fires.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function onLeave(_e: DragEvent) {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) dragOver = false;
  }

  function onDrop(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounter = 0;
    dragOver = false;
    const handler = activeHandler();
    const files = e.dataTransfer?.files;
    if (!handler || !files || files.length === 0) return;
    handler.onFiles(Array.from(files));
  }

  function ensureAttached() {
    if (attached || typeof document === "undefined") return;
    document.body.addEventListener("dragenter", onEnter);
    document.body.addEventListener("dragover", onOver);
    document.body.addEventListener("dragleave", onLeave);
    document.body.addEventListener("drop", onDrop);
    attached = true;
  }

  function detach() {
    if (!attached || typeof document === "undefined") return;
    document.body.removeEventListener("dragenter", onEnter);
    document.body.removeEventListener("dragover", onOver);
    document.body.removeEventListener("dragleave", onLeave);
    document.body.removeEventListener("drop", onDrop);
    attached = false;
    dragCounter = 0;
    dragOver = false;
  }

  function register(handler: DragDropHandler): () => void {
    handlers.push(handler);
    ensureAttached();
    return () => {
      const idx = handlers.lastIndexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
      if (handlers.length === 0) detach();
    };
  }

  return {
    get dragOver() {
      return dragOver;
    },
    register,
  };
}

export function setDragDropContext(): DragDropContext {
  const ctx = createDragDropContext();
  setContext(CONTEXT_KEY, ctx);
  return ctx;
}

export function getDragDropContext(): DragDropContext {
  const ctx = getContext<DragDropContext | undefined>(CONTEXT_KEY);
  if (!ctx) {
    throw new Error(
      "DragDropContext not found. Call setDragDropContext() in the root layout.",
    );
  }
  return ctx;
}
