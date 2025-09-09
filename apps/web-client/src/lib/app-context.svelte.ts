import { getContext, setContext } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { DaemonClient } from "./modules/client/daemon.ts";
import { getAtlasDaemonUrl } from "./utils/daemon.ts";

const KEY = Symbol();

export type KeyboardModifier = "shift" | "option" | "command" | "control";
export type KeyboardValue = {
  key: string | null;
  modifiers: KeyboardModifier[];
  pressing?: boolean;
};

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
  const state = new SvelteMap<string, { name: string; path: string }>();

  return {
    get state() {
      return state;
    },
    add: (itemId: string, { name, path }: { name: string; path: string }) => {
      state.set(itemId, { name, path });
    },
    remove: (itemId: string) => {
      state.delete(itemId);
    },
  };
}

export type RouteConfig = ReturnType<typeof getRouteConfig>;
export function getRouteConfig() {
  return {
    main: "/",
    library: { list: "/library", item: (id: string) => `/library/${id}` },
  } as const;
}

export function setAppContext() {
  const routes = getRouteConfig();
  const keyboard = createKeyboard();
  const daemonClient = new DaemonClient({ daemonUrl: getAtlasDaemonUrl() });
  const stagedFiles = createStagedFiles();

  async function uploadFile(file: File) {
    const item = await daemonClient.createLibraryItem(file);

    if (item.success) {
      console.log(item);
      stagedFiles.add(item.itemId, { name: item.item.name, path: item.path });
    }
  }

  const ctx = { keyboard, routes, daemonClient, stagedFiles, uploadFile };
  return setContext(KEY, ctx);
}

export function getAppContext() {
  return getContext<ReturnType<typeof setAppContext>>(KEY);
}
