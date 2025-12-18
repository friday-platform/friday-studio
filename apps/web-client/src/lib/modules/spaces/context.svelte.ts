import { client, type InferResponseType, parseResult } from "@atlas/client/v2";
import { getContext, setContext } from "svelte";

const KEY = Symbol("spaces");

type WorkspacesListResponse = InferResponseType<typeof client.workspace.index.$get, 200>;

class SpacesContext {
  workspaces = $state<WorkspacesListResponse>([]);
  isLoading = $state(false);

  async fetchWorkspaces() {
    this.isLoading = true;
    try {
      const res = await parseResult(client.workspace.index.$get());
      if (!res.ok) {
        console.error("Failed to load spaces:", res.error);
        this.workspaces = [];
        return;
      }
      this.workspaces = res.data.filter(
        (w) => w.name !== "atlas-conversation" && !w.path.includes("/examples/"),
      );
    } catch (error) {
      console.error("Failed to load spaces:", error);
      this.workspaces = [];
    } finally {
      this.isLoading = false;
    }
  }
}

export function setSpacesContext() {
  const ctx = new SpacesContext();
  return setContext(KEY, ctx);
}

export function getSpacesContext() {
  return getContext<ReturnType<typeof setSpacesContext>>(KEY);
}
