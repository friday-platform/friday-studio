import { getContext, setContext } from "svelte";

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
    update: (value: KeyboardValue | undefined) => (state = value),
  };
}

export type SidebarVisibility = "expanded" | "collapsed";

type StateSession = { sidebarVisible?: SidebarVisibility };

function createStateSession(initialValue: StateSession = { sidebarVisible: "expanded" }) {
  let state = $state(initialValue);

  return {
    get state() {
      return state;
    },
    update: (value: StateSession) => (state = value),
    toggleSidebar: ({ value, persist = true }: { value: SidebarVisibility; persist?: boolean }) => {
      state = { ...state, sidebarVisible: value };

      if (persist) {
        localStorage.setItem("tempest-sidebar-visibility", value);
      }
    },
  };
}

export type RouteConfig = ReturnType<typeof getRouteConfig>;
export function getRouteConfig() {
  return { api: {}, workspaces: {}, library: {}, settings: {} } as const;
}

/**
 * Sets a global context containing the app's state. This has a couple quirks which
 * merit explanation:
 * 1. The input is a query result from Tanstack Query, which is a rune. Destructuring or
 *    deriving state from this query doesn't correctly update context consumers, so it
 *    must remain intact when provided.
 * 2. The selected organization is passed in from the layout load function and _isn't_
 *    reactive. This is okay because the user's organization can only be changed by
 *    hard-navigating to a different org route, triggering a full page reload and thus
 *    instantiating a new context.
 *
 * @see https://svelte.dev/docs/svelte/context
 * @todo dig more into _why_ you can't expose derived values or destructure state within a
 *       context. This doesn't make a huge amount of sense based on my read of the docs.
 */
export function setAppContext(initialSidebarVisibility?: SidebarVisibility) {
  const routes = getRouteConfig();
  const keyboard = createKeyboard();
  const stateSession = createStateSession({ sidebarVisible: initialSidebarVisibility });

  const ctx = { keyboard, routes, stateSession };
  setContext(KEY, ctx);
  return ctx;
}

export function getAppContext() {
  return getContext<ReturnType<typeof setAppContext>>(KEY);
}
