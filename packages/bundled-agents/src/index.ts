/**
 * Bundled Agents for Atlas
 *
 * This package contains pre-installed agents that are compiled into Atlas
 * and available to all workspaces by default.
 */

import type { AtlasAgent } from "@atlas/agent-sdk";
import { type ResearchOutput, targetedResearchAgent } from "./research/targeted-research.ts";
import { SlackAgentResultSchema, slackCommunicatorAgent } from "./slack/slack-communicator.ts";

// Add more bundled agents here as they are created
export const bundledAgents: AtlasAgent[] = [targetedResearchAgent, slackCommunicatorAgent];

export { targetedResearchAgent };
export { slackCommunicatorAgent };
export { SlackAgentResultSchema };
export type { ResearchOutput };
