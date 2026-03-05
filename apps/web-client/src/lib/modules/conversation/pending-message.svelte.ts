/**
 * Transient store for passing a message from the workspace overview page
 * to the workspace chat page. Consumed once on the chat page mount.
 */
let value = $state<string | null>(null);

export const pendingWorkspaceMessage = {
  get(): string | null {
    const msg = value;
    value = null;
    return msg;
  },
  set(message: string) {
    value = message;
  },
};
