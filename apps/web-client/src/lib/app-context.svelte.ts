import { getContext, setContext } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { resolve } from "$app/paths";

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
    main: "/",
    library: {
      list: resolve("/library", {}),
      item: (libraryId: string) => resolve("/library/[libraryId]", { libraryId }),
    },
    sessions: {
      list: resolve("/sessions", {}),
      item: (sessionId: string) => resolve("/sessions/[sessionId]", { sessionId }),
    },
    chat: { item: (chatId: string) => resolve("/chat/[chatId]", { chatId }) },
    spaces: {
      item: (spaceId: string, view?: string) =>
        view
          ? resolve("/spaces/[spaceId]/[view]", { spaceId, view })
          : resolve("/spaces/[spaceId]", { spaceId }),
    },
    settings: resolve("/settings", {}),
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
  stagedFiles = createStagedFiles();

  #sidebarExpanded = $state(getInitialSidebarState());
  addWorkspaceDialogOpen = $state(false);

  get sidebarExpanded() {
    return this.#sidebarExpanded;
  }

  set sidebarExpanded(value: boolean) {
    this.#sidebarExpanded = value;
    if (typeof window !== "undefined") {
      localStorage.setItem("atlas:sidebarExpanded", JSON.stringify(value));
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
