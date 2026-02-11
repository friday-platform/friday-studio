import { createCollapsible, type CreateCollapsibleProps } from "@melt-ui/svelte";
import { getContext as _getContext, setContext } from "svelte";

const CONTEXT = "__collapsible";

export function createContext(args: CreateCollapsibleProps = { forceVisible: true }) {
  const {
    elements: { root, trigger, content },
    states: { open },
  } = createCollapsible(args);
  const ctx = { root, trigger, content, open };
  setContext(CONTEXT, ctx);
  return ctx;
}

export function getContext() {
  return _getContext<ReturnType<typeof createContext>>(CONTEXT);
}
