/**
 * Per-turn `<variable-values>` snapshot for the workspace-chat system prompt.
 *
 * Decision 3 (volatile half): block 2 carries variable *declarations* (name +
 * description, 1h cache tier). This module emits the *current values* state —
 * which variables are filled, which use a schema default, which are unset —
 * into block 4 so the agent can answer "what's still missing?" and "is
 * MAX_PRICE actually set?" without busting the 1h workspace-narrative cache
 * on every `.env` write.
 *
 * The `filled` / `source` attributes come from `resolveVariableState` so the
 * agent's "filled" view never drifts from what the daemon would resolve at
 * config-load time. No values, no schemas — declarations stay in block 2.
 */

import type { WorkspaceConfig } from "@atlas/config";
import { variableEnvKey } from "@atlas/workspace/variable-interpolation";
import { resolveVariableState } from "@atlas/workspace/variable-state";

/**
 * Build the `<variable-values>` block for the current turn. Returns `null`
 * when the workspace declares no variables — callers `filter(Boolean)` the
 * result into block 4, so a null fallthrough keeps the block byte-identical
 * to today's output for workspaces without a `variables:` declaration.
 *
 * Iteration order is `Object.entries` declaration order, which is stable
 * across calls with equal inputs (same input record → same key order).
 */
export function formatVariableValuesBlock(
  config: WorkspaceConfig | undefined,
  envSnapshot: Record<string, string>,
): string | null {
  const entries = Object.entries(config?.variables ?? {});
  if (entries.length === 0) return null;

  const elements = entries.map(([name, declaration]) => {
    const state = resolveVariableState(name, declaration, envSnapshot[variableEnvKey(name)]);
    return `<variable name="${name}" filled="${state.is_filled}" source="${state.source}"/>`;
  });

  return `<variable-values>\n${elements.join("\n")}\n</variable-values>`;
}
