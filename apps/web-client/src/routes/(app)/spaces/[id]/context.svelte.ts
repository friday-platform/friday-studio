import { getContext, setContext } from "svelte";

const KEY = Symbol();

interface Workspace {
  id: string;
  name: string;
  description?: string;
  status: string;
  path: string;
  createdAt: string;
  lastSeen: string;
}

class SpaceLayoutContext {
  workspace = $state<Workspace | null>(null);

  constructor(workspace: Workspace) {
    this.workspace = workspace;
  }
}

export function setSpaceLayoutContext(workspace: Workspace) {
  const ctx = new SpaceLayoutContext(workspace);
  return setContext(KEY, ctx);
}

export function getSpaceLayoutContext() {
  return getContext<ReturnType<typeof setSpaceLayoutContext>>(KEY);
}
