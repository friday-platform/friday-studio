/**
 * Wraps tools to inject _sessionContext into their arguments.
 * Used by conversation agent to provide datetime for timezone-aware operations.
 */

import type { AtlasTools } from "@atlas/agent-sdk";

export function wrapToolsWithSessionContext(
  tools: AtlasTools,
  sessionContext: Record<string, unknown>,
  allowedTools: Set<string>,
): AtlasTools {
  const filteredTools: AtlasTools = {};
  for (const [name, t] of Object.entries(tools)) {
    if (!allowedTools.has(name)) continue;
    if (!t.execute) {
      filteredTools[name] = t;
      continue;
    }
    const orig = t.execute;
    filteredTools[name] = {
      ...t,
      execute: (args, opts) => orig({ ...args, _sessionContext: sessionContext }, opts),
    };
  }
  return filteredTools;
}
