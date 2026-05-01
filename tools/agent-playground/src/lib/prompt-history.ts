/**
 * Per-agent prompt history with localStorage persistence.
 *
 * Provides shell-style up/down cycling through previous prompts,
 * deduplication of consecutive entries, and draft text stashing.
 *
 * Key format: `prompt-history-{agentId}`
 *
 * @module
 */

const MAX_ENTRIES = 50;
const KEY_PREFIX = "prompt-history-";
const DRAFT_PREFIX = "prompt-draft-";

/** Current cycle index per agent. -1 means "not cycling" (past newest). */
let cycleIndex = -1;
/** Which agent the current cycle index belongs to. */
let cycleAgent: string | null = null;

/**
 * Read the history array for an agent from localStorage.
 * Returns an empty array if nothing stored or on parse failure.
 */
function readHistory(agentId: string): string[] {
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${agentId}`);
    if (raw === null) return [];
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

/**
 * Write the history array for an agent to localStorage.
 */
function writeHistory(agentId: string, entries: string[]): void {
  try {
    localStorage.setItem(`${KEY_PREFIX}${agentId}`, JSON.stringify(entries));
  } catch {
    // localStorage unavailable — degrade silently
  }
}

/**
 * Append a prompt to the agent's history.
 * Deduplicates consecutive identical entries. Caps at 50 entries (oldest dropped).
 */
export function push(agentId: string, prompt: string): void {
  const entries = readHistory(agentId);

  // Deduplicate consecutive identical prompts
  if (entries.length > 0 && entries[entries.length - 1] === prompt) {
    return;
  }

  entries.push(prompt);

  // Cap at MAX_ENTRIES, dropping oldest
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }

  writeHistory(agentId, entries);
}

/**
 * Cycle through history for an agent.
 *
 * @param direction - `"prev"` moves toward older entries, `"next"` toward newer
 * @returns The history entry at the new position, or `null` at boundaries
 */
export function cycle(agentId: string, direction: "prev" | "next"): string | null {
  const entries = readHistory(agentId);
  if (entries.length === 0) return null;

  if (direction === "prev") {
    if (cycleAgent !== agentId) {
      // First prev for this agent — start at the end
      cycleIndex = entries.length - 1;
      cycleAgent = agentId;
      return entries[cycleIndex] ?? null;
    }

    // Already cycling — move backward
    const next = cycleIndex - 1;
    if (next < 0) return null;
    cycleIndex = next;
    return entries[cycleIndex] ?? null;
  }

  // direction === "next"
  if (cycleAgent !== agentId || cycleIndex === -1) {
    // Not in history mode for this agent
    return null;
  }

  const next = cycleIndex + 1;
  if (next >= entries.length) {
    // Past newest — exit history mode
    cycleIndex = -1;
    cycleAgent = null;
    return null;
  }
  cycleIndex = next;
  return entries[cycleIndex] ?? null;
}

/**
 * Reset the cycle index. Called when the user types, exiting history mode.
 */
export function reset(): void {
  cycleIndex = -1;
  cycleAgent = null;
}

/**
 * Stash in-progress text for an agent.
 */
export function saveDraft(agentId: string, text: string): void {
  try {
    localStorage.setItem(`${DRAFT_PREFIX}${agentId}`, text);
  } catch {
    // localStorage unavailable — degrade silently
  }
}

/**
 * Retrieve stashed draft text for an agent.
 * Returns `null` if no draft exists.
 */
export function restoreDraft(agentId: string): string | null {
  try {
    return localStorage.getItem(`${DRAFT_PREFIX}${agentId}`);
  } catch {
    return null;
  }
}
