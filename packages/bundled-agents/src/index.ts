/**
 * Bundled Agents for Atlas
 *
 * This package contains pre-installed agents that are compiled into Atlas
 * and available to all workspaces by default.
 */

import type { AtlasAgent } from "@atlas/agent-sdk";

import { GoogleCalendarAgentResultSchema, googleCalendarAgent } from "./google/calendar.ts";
import { type ResearchOutput, targetedResearchAgent } from "./research/targeted-research.ts";
import { slackCommunicatorAgent } from "./slack/slack-communicator.ts";

// Add more bundled agents here as they are created
export const bundledAgents: AtlasAgent[] = [
  targetedResearchAgent,
  slackCommunicatorAgent,
  googleCalendarAgent,
];

export { targetedResearchAgent, slackCommunicatorAgent, GoogleCalendarAgentResultSchema };

export type { ResearchOutput };
