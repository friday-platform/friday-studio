import type { MemoryConfig } from "@atlas/config";
import { USER_WORKSPACE_ID } from "../../src/factory.ts";

/**
 * Default memory config applied to new workspaces when none is provided.
 *
 * - notes: short-term corpus for agent writes (observations, results, preferences)
 * - memory: long-term corpus populated by the global reflector in the system workspace
 *
 * Mounts pull the user workspace's narrative corpora into every new workspace
 * at the workspace scope so agents see personal context without explicit config.
 */
export const DEFAULT_WORKSPACE_MEMORY: MemoryConfig = {
  own: [
    { name: "notes", type: "short_term", strategy: "narrative" },
    { name: "memory", type: "long_term", strategy: "narrative" },
  ],
  mounts: [
    {
      name: "user-notes",
      source: `${USER_WORKSPACE_ID}/narrative/notes`,
      mode: "ro",
      scope: "workspace",
    },
    {
      name: "user-memory",
      source: `${USER_WORKSPACE_ID}/narrative/memory`,
      mode: "ro",
      scope: "workspace",
    },
  ],
};
