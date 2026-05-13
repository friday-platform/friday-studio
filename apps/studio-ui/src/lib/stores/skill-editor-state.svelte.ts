/**
 * Shared reactive state for the skill file editor.
 *
 * Tracks which files have unsaved changes so the tree can show
 * dirty indicators. Lives in a `.svelte.ts` module so it uses
 * Svelte 5 fine-grained reactivity.
 *
 * @module
 */

let _dirtyFiles = $state(new Set<string>());

/**
 * Returns the current set of file paths with unsaved changes.
 */
export function getDirtyFiles(): Set<string> {
  return _dirtyFiles;
}

/**
 * Marks a file path as dirty (has unsaved changes).
 */
export function markDirty(path: string): void {
  const next = new Set(_dirtyFiles);
  next.add(path);
  _dirtyFiles = next;
}

/**
 * Marks a file path as clean (no unsaved changes).
 */
export function markClean(path: string): void {
  if (!_dirtyFiles.has(path)) return;
  const next = new Set(_dirtyFiles);
  next.delete(path);
  _dirtyFiles = next;
}
