/**
 * Element-scoped drag-and-drop state machine.
 *
 * Factory returns a reactive `dragOver` flag and the four event
 * handlers a component wires to its root element. No global document
 * listeners — drops fire only inside the element that owns the
 * handlers, so multiple zones on the same page cannot collide.
 *
 * Filtering (image-only, size limits, MIME checks, etc.) is the
 * caller's job — the state machine forwards every dropped file as a
 * `File[]`. The only filter built in is "must be a file drag" — drags
 * that don't carry files (text, URLs from another tab) are ignored so
 * the zone doesn't visually react to them.
 *
 * For component usage, prefer `<DragDropZone>`, which wraps this.
 *
 * @module
 */

export interface DragDropState {
  /** True while a file drag is hovering inside the owning element. */
  readonly dragOver: boolean;
  onDragEnter(e: DragEvent): void;
  onDragOver(e: DragEvent): void;
  onDragLeave(e: DragEvent): void;
  onDrop(e: DragEvent): void;
}

export function createDragDropState(
  onFiles: (files: File[]) => void,
): DragDropState {
  let dragOver = $state(false);
  // Nested children fire dragleave on the parent and dragenter on the
  // child as the cursor crosses element boundaries. A counter that
  // increments on enter and decrements on leave only returns to zero
  // when the cursor exits the owning element entirely.
  let dragCounter = 0;

  function hasFiles(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (const t of types) {
      if (t === "Files") return true;
    }
    return false;
  }

  function onDragEnter(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounter++;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    dragOver = true;
  }

  function onDragOver(e: DragEvent) {
    if (!hasFiles(e)) return;
    // preventDefault on dragover is REQUIRED — without it the browser
    // rejects the drop and `drop` never fires.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(_e: DragEvent) {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) dragOver = false;
  }

  function onDrop(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounter = 0;
    dragOver = false;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    onFiles(Array.from(files));
  }

  return {
    get dragOver() {
      return dragOver;
    },
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  };
}
