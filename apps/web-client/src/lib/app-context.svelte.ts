import { getContext, setContext } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { base } from "$app/paths";
import { DaemonClient } from "./modules/client/daemon.ts";

const KEY = Symbol();

export type KeyboardModifier = "shift" | "option" | "command" | "control";
type KeyboardValue = { key: string | null; modifiers: KeyboardModifier[]; pressing?: boolean };

function createKeyboard() {
  let state = $state<KeyboardValue | undefined>();
  return {
    get state() {
      return state;
    },
    update: (value: KeyboardValue | undefined) => {
      state = value;
    },
  };
}

function createStagedFiles() {
  const state = new SvelteMap<string, { path: string; name: string; type: "file" | "folder" }>();

  return {
    get state() {
      return state;
    },
    add: (itemId: string, { path, type }: { path: string; type: "file" | "folder" }) => {
      const name = path.split(/[/\\]/).pop() || path;
      state.set(itemId, { path, name, type });
    },
    remove: (itemId: string) => {
      state.delete(itemId);
    },
    clear: () => {
      state.clear();
    },
  };
}

export function getFileType(path: string) {
  const hasExtension = /\.[^/\\]+$/.test(path);
  return hasExtension ? "file" : "folder";
}

function getRouteConfig() {
  return {
    main: `${base}/`,
    library: {
      list: `${base}/library`,
      item: (libraryId: string) => `${base}/library/${libraryId}`,
    },
    sessions: {
      list: `${base}/sessions`,
      item: (sessionId: string) => `${base}/sessions/${sessionId}`,
    },
    chat: { item: (id: string) => `${base}/chat/${id}` },
    spaces: {
      item: (id: string, view?: string) =>
        view ? `${base}/spaces/${id}/${view}` : `${base}/spaces/${id}`,
    },
    settings: `${base}/settings`,
  } as const;
}

function getInitialSidebarState(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem("atlas:sidebarExpanded");
  if (stored !== null) {
    const parsed = JSON.parse(stored);
    if (typeof parsed === "boolean") {
      return parsed;
    }
  }
  return false;
}

class AppContext {
  keyboard = createKeyboard();
  routes = getRouteConfig();
  daemonClient = new DaemonClient();
  stagedFiles = createStagedFiles();

  #sidebarExpanded = $state(getInitialSidebarState());
  addWorkspaceDialogOpen = $state(false);
  #workspacesRefreshCallback: (() => void) | null = null;

  get sidebarExpanded() {
    return this.#sidebarExpanded;
  }

  set sidebarExpanded(value: boolean) {
    this.#sidebarExpanded = value;
    if (typeof window !== "undefined") {
      localStorage.setItem("atlas:sidebarExpanded", JSON.stringify(value));
    }
  }

  setWorkspacesRefreshCallback(callback: () => void) {
    this.#workspacesRefreshCallback = callback;
  }

  refreshWorkspaces() {
    if (this.#workspacesRefreshCallback) {
      this.#workspacesRefreshCallback();
    }
  }
}

export function setAppContext() {
  const ctx = new AppContext();

  return setContext(KEY, ctx);
}

export function getAppContext() {
  return getContext<ReturnType<typeof setAppContext>>(KEY);
}
