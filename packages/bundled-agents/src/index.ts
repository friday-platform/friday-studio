/**
 * Bundled Agents for Atlas
 *
 * This package contains pre-installed agents that are compiled into Atlas
 * and available to all workspaces by default.
 */

import type { AtlasAgent } from "@atlas/agent-sdk";
import { claudeCodeAgent } from "./claude-code/agent.ts";
import { csvFilterSamplerAgent } from "./csv/filter.ts";
import { type DataAnalystResult, dataAnalystAgent } from "./data-analyst/agent.ts";
import type { QueryExecution } from "./data-analyst/sql-tools.ts";
import { emailAgent } from "./email/communicator.ts";
import { fathomGetTranscriptAgent } from "./fathom-ai/get-transcript.ts";
import { GoogleCalendarAgentResultSchema, googleCalendarAgent } from "./google/calendar.ts";
import { slackCommunicatorAgent } from "./slack/communicator.ts";
import { summaryAgent } from "./summary.ts";
import { tableAgent } from "./table.ts";
import { webSearchAgent } from "./web-search/web-search.ts";

// Add more bundled agents here as they are created
export const bundledAgents: AtlasAgent[] = [
  slackCommunicatorAgent,
  googleCalendarAgent,
  webSearchAgent,
  summaryAgent,
  emailAgent,
  fathomGetTranscriptAgent,
  claudeCodeAgent,
  csvFilterSamplerAgent,
  dataAnalystAgent,
  tableAgent,
];

export {
  claudeCodeAgent,
  csvFilterSamplerAgent,
  dataAnalystAgent,
  emailAgent,
  fathomGetTranscriptAgent,
  googleCalendarAgent,
  GoogleCalendarAgentResultSchema,
  webSearchAgent,
  slackCommunicatorAgent,
  tableAgent,
};

export type { DataAnalystResult, QueryExecution };
