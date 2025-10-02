/**
 * Bundled Agents for Atlas
 *
 * This package contains pre-installed agents that are compiled into Atlas
 * and available to all workspaces by default.
 */

import type { AtlasAgent } from "@atlas/agent-sdk";
import { GoogleCalendarAgentResultSchema, googleCalendarAgent } from "./google/calendar.ts";
import { researchAgent } from "./research/mod.ts";
import { slackCommunicatorAgent } from "./slack/communicator.ts";
import { summaryAgent } from "./summary.ts";

// Add more bundled agents here as they are created
export const bundledAgents: AtlasAgent[] = [
  slackCommunicatorAgent,
  googleCalendarAgent,
  researchAgent,
  summaryAgent,
];

export { slackCommunicatorAgent, GoogleCalendarAgentResultSchema, researchAgent };
