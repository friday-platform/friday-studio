/**
 * Bundled Agents for Atlas
 *
 * This package contains pre-installed agents that are compiled into Atlas
 * and available to all workspaces by default.
 */

import type { AtlasAgent } from "@atlas/agent-sdk";
import { ClaudeCodeOutputSchema, claudeCodeAgent } from "./claude-code/agent.ts";
import { csvFilterSamplerAgent } from "./csv/filter.ts";
import { type DataAnalystResult, dataAnalystAgent } from "./data-analyst/agent.ts";
import type { QueryExecution } from "./data-analyst/sql-tools.ts";
import { EmailOutputSchema, emailAgent } from "./email/communicator.ts";
import { FathomOutputSchema, fathomGetTranscriptAgent } from "./fathom-ai/get-transcript.ts";
import { GoogleCalendarOutputSchema, googleCalendarAgent } from "./google/calendar.ts";
import { SlackOutputSchema, slackCommunicatorAgent } from "./slack/communicator.ts";
import { SummaryOutputSchema, summaryAgent } from "./summary.ts";
import { tableAgent } from "./table.ts";
import { ResearchOutputSchema, webSearchAgent } from "./web-search/web-search.ts";

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
  webSearchAgent,
  slackCommunicatorAgent,
  summaryAgent,
  tableAgent,
  ClaudeCodeOutputSchema,
  EmailOutputSchema,
  FathomOutputSchema,
  GoogleCalendarOutputSchema,
  ResearchOutputSchema,
  SlackOutputSchema,
  SummaryOutputSchema,
};

export type { DataAnalystResult, QueryExecution };

export {
  type BundledAgentConfigField,
  type BundledAgentConfigFieldInput,
  type BundledAgentRegistryItem,
  bundledAgentsRegistry,
} from "./registry.ts";
