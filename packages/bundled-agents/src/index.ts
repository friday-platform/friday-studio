/**
 * Bundled Agents for Atlas
 *
 * This package contains pre-installed agents that are compiled into Atlas
 * and available to all workspaces by default.
 */

import type { AtlasAgent } from "@atlas/agent-sdk";
import { targetedResearchAgent } from "./targeted-research.ts";

// Add more bundled agents here as they are created
export const bundledAgents: AtlasAgent[] = [targetedResearchAgent];

export { targetedResearchAgent };
