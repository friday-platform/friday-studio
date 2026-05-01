/**
 * localStorage persistence for collapsible section expand/collapse state.
 *
 * Key format: `cockpit-section-{workspaceId}-{sectionKey}`
 *
 * @module
 */

/** Build the localStorage key for a collapsible section. */
export function sectionStorageKey(workspaceId: string, sectionKey: string): string {
  return `cockpit-section-${workspaceId}-${sectionKey}`;
}

/** Read persisted collapse state. Returns `defaultExpanded` when no entry exists. */
export function readSectionState(
  workspaceId: string,
  sectionKey: string,
  defaultExpanded: boolean,
): boolean {
  try {
    const stored = localStorage.getItem(sectionStorageKey(workspaceId, sectionKey));
    if (stored === null) return defaultExpanded;
    return stored === "true";
  } catch {
    return defaultExpanded;
  }
}

/** Persist collapse state to localStorage. */
export function writeSectionState(
  workspaceId: string,
  sectionKey: string,
  expanded: boolean,
): void {
  try {
    localStorage.setItem(sectionStorageKey(workspaceId, sectionKey), String(expanded));
  } catch {
    // localStorage unavailable — degrade silently
  }
}
