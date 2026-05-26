/**
 * Per-workspace conversational model override, persisted to localStorage.
 *
 * Storage key format: `model-override-${workspaceId}`
 * Value format: `"<provider>:<modelId>"` (matches workspace-chat agent input)
 *
 * Threaded through `body.model` → daemon `WebChatPayload.model` →
 * `signalData.modelOverride` → agent `session.modelOverride`.
 *
 * @module
 */

const KEY_PREFIX = "model-override-";

function storageKey(workspaceId: string): string {
  return `${KEY_PREFIX}${workspaceId}`;
}

/**
 * Read the model override spec for a workspace.
 * Returns `null` if no override is set or localStorage is unavailable.
 */
export function getModelOverride(workspaceId: string): string | null {
  try {
    return localStorage.getItem(storageKey(workspaceId));
  } catch {
    return null;
  }
}

/**
 * Set or clear the model override for a workspace.
 *
 * Passing `null` removes the key entirely (not the string `"null"`), so
 * subsequent reads return `null` and the chat-send body omits the field.
 */
export function setModelOverride(workspaceId: string, spec: string | null): void {
  try {
    if (spec === null) {
      localStorage.removeItem(storageKey(workspaceId));
    } else {
      localStorage.setItem(storageKey(workspaceId), spec);
    }
  } catch {
    // localStorage unavailable — degrade silently
  }
}
