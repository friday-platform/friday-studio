/**
 * Bundled Agents for Atlas
 *
 * This package contains pre-installed agents that are compiled into Atlas
 * and available to all workspaces by default.
 */

import type { AtlasAgent } from "@atlas/agent-sdk";
import { slackCommunicatorAgent } from "./slack-communicator.ts";
import { type ResearchOutput, targetedResearchAgent } from "./targeted-research.ts";

// Add more bundled agents here as they are created
export const bundledAgents: AtlasAgent[] = [targetedResearchAgent, slackCommunicatorAgent];

export { targetedResearchAgent };
export { slackCommunicatorAgent };
export type { ResearchOutput };
