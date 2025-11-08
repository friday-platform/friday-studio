import { type CreateDialogProps, createDialog } from "@melt-ui/svelte";
import { getContext as _getContext, setContext } from "svelte";

const KEY = Symbol();

export function createContext(args: CreateDialogProps = { forceVisible: true }) {
  const { elements, states } = createDialog({ ...args, portal: "body" });
  const ctx = { ...elements, ...states };
  setContext(KEY, ctx);
  return ctx;
}

export function getContext() {
  return _getContext<ReturnType<typeof createContext>>(KEY);
}
