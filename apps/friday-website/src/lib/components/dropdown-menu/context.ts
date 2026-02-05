import { type CreateDropdownMenuProps, createDropdownMenu } from "@melt-ui/svelte";
import { getContext as _getContext, setContext } from "svelte";

const CONTEXT = Symbol();

export function createContext(args: CreateDropdownMenuProps = { forceVisible: true }) {
  const {
    elements: { trigger, menu, item, overlay, separator },
    states: { open },
    options: { positioning },
  } = createDropdownMenu({
    ...args,
    positioning: { ...(args.positioning ?? {}), fitViewport: true },
  });

  const ctx = { trigger, menu, item, overlay, separator, open, positioning };
  setContext(CONTEXT, ctx);
  return ctx;
}

export function getContext() {
  return _getContext<ReturnType<typeof createContext>>(CONTEXT);
}
