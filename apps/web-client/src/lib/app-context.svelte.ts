import { getContext, setContext } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { DaemonClient } from "./modules/client/daemon.ts";
import { getAtlasDaemonUrl } from "./utils/daemon.ts";

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
  const state = new SvelteMap<string, { path: string; type: "file" | "folder" }>();

  return {
    get state() {
      return state;
    },
    add: (itemId: string, { path, type }: { path: string; type: "file" | "folder" }) => {
      state.set(itemId, { path, type });
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
    library: { list: "/library", item: (id: string) => `/library/${id}` },
    chat: { item: (id: string) => `/chat/${id}` },
    settings: "/settings",
  } as const;
}

class AppContext {
  keyboard = createKeyboard();
  routes = getRouteConfig();
  daemonClient = new DaemonClient({ daemonUrl: getAtlasDaemonUrl() });
  stagedFiles = createStagedFiles();

  sidebarExpanded = $state(false);
}

export function setAppContext() {
  const ctx = new AppContext();

  return setContext(KEY, ctx);
}

export function getAppContext() {
  return getContext<ReturnType<typeof setAppContext>>(KEY);
}
