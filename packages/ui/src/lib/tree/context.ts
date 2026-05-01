import { createTreeView, type CreateTreeViewProps } from "@melt-ui/svelte";
import { getContext as _getContext, setContext } from "svelte";

const CONTEXT = "__tree";

/**
 * @description Creates a tree view context and stores it for child components.
 * @param args - Configuration options for the Melt UI tree view builder.
 * @returns The tree view elements, states, and helpers.
 */
export function createContext(args: CreateTreeViewProps = { forceVisible: true }) {
  const {
    elements: { tree, item, group },
    states: { expanded, selectedItem },
    helpers: { isExpanded, isSelected },
  } = createTreeView(args);
  const ctx = { tree, item, group, expanded, selectedItem, isExpanded, isSelected };
  setContext(CONTEXT, ctx);
  return ctx;
}

/**
 * @description Retrieves the tree view context set by a parent Tree.Root component.
 * @returns The tree view elements, states, and helpers.
 */
export function getContext() {
  return _getContext<ReturnType<typeof createContext>>(CONTEXT);
}
