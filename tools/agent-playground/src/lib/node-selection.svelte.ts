/**
 * URL-based node selection for the pipeline diagram.
 *
 * Selection state is encoded in the URL path, making sidebar panels
 * directly routable and linkable. Click handlers navigate to the
 * appropriate URL; the layout reads route params for sidebar content.
 *
 * @module
 */
import type { TopologyNode } from "@atlas/config/topology";
import { goto } from "$app/navigation";
import { page } from "$app/state";

/**
 * Navigate to a node's panel URL. Clicking the already-selected node
 * toggles it off (navigates back to base workspace route).
 */
export function selectNode(node: TopologyNode) {
  const workspaceId = page.params.workspaceId;
  if (!workspaceId) return;

  const basePath = `/platform/${workspaceId}`;

  // Derive current selection from route params
  let currentId: string | null = null;
  if (page.params.signalId) currentId = `signal:${page.params.signalId}`;
  else if (page.params.nodeId) currentId = page.params.nodeId;

  // Toggle off if clicking the already-selected node
  if (currentId === node.id) {
    goto(basePath);
    return;
  }

  if (node.type === "signal") {
    const signalId = node.id.replace(/^signal:/, "");
    goto(`${basePath}/signal/${signalId}`);
  } else if (node.type === "agent-step") {
    goto(`${basePath}/agent/${node.id}`);
  }
}

/** Clear selection by navigating to the base workspace route. */
export function clearSelection() {
  const workspaceId = page.params.workspaceId;
  if (!workspaceId) return;
  goto(`/platform/${workspaceId}`);
}
