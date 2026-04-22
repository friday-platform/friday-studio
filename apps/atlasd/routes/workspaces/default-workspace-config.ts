import type { MemoryConfig } from "@atlas/config";

/**
 * Default memory config applied to new workspaces when none is provided.
 *
 * - notes: short-term corpus for agent writes (observations, results, preferences)
 * - memory: long-term corpus populated by the global reflector in the system workspace
 */
export const DEFAULT_WORKSPACE_MEMORY: MemoryConfig = {
  own: [
    { name: "notes", type: "short_term", strategy: "narrative" },
    { name: "memory", type: "long_term", strategy: "narrative" },
  ],
  mounts: [],
};
