import { BbOutputSchema, bbAgent } from "./bb/agent.ts";
import { ClaudeCodeOutputSchema, claudeCodeAgent } from "./claude-code/agent.ts";
import { CsvFilterSamplerOutputSchema, csvFilterSamplerAgent } from "./csv/filter.ts";
import { type DataAnalystResult, dataAnalystAgent } from "./data-analyst/agent.ts";
import type { QueryExecution } from "./data-analyst/sql-tools.ts";
import { EmailOutputSchema, emailAgent } from "./email/communicator.ts";
import { FathomOutputSchema, fathomGetTranscriptAgent } from "./fathom-ai/get-transcript.ts";
import { GhOutputSchema, ghAgent } from "./gh/agent.ts";
import { GoogleCalendarOutputSchema, googleCalendarAgent } from "./google/calendar.ts";
import { HubSpotOutputSchema, hubspotAgent } from "./hubspot/index.ts";
import { JiraOutputSchema, jiraAgent } from "./jira/agent.ts";
import { SlackOutputSchema, slackCommunicatorAgent } from "./slack/communicator.ts";
import {
  SnowflakeAnalystOutputSchema,
  type SnowflakeAnalystResult,
  snowflakeAnalystAgent,
} from "./snowflake-analyst/agent.ts";
import { SummaryOutputSchema, summaryAgent } from "./summary.ts";
import { tableAgent } from "./table.ts";
import { TranscriptionOutputSchema, transcriptionAgent } from "./transcription/agent.ts";
import { type DiscoveredAudio, discoverAudioFiles } from "./transcription/discovery.ts";
import { ResearchOutputSchema, webSearchAgent } from "./web-search/web-search.ts";

export {
  type BundledAgentConfigField,
  type BundledAgentRegistryEntry,
  bundledAgents,
  bundledAgentsRegistry,
} from "./registry.ts";

export type { DataAnalystResult, DiscoveredAudio, QueryExecution, SnowflakeAnalystResult };
export {
  BbOutputSchema,
  bbAgent,
  ClaudeCodeOutputSchema,
  CsvFilterSamplerOutputSchema,
  claudeCodeAgent,
  csvFilterSamplerAgent,
  dataAnalystAgent,
  discoverAudioFiles,
  EmailOutputSchema,
  emailAgent,
  FathomOutputSchema,
  fathomGetTranscriptAgent,
  GhOutputSchema,
  GoogleCalendarOutputSchema,
  ghAgent,
  googleCalendarAgent,
  HubSpotOutputSchema,
  hubspotAgent,
  JiraOutputSchema,
  jiraAgent,
  ResearchOutputSchema,
  SlackOutputSchema,
  SnowflakeAnalystOutputSchema,
  SummaryOutputSchema,
  slackCommunicatorAgent,
  snowflakeAnalystAgent,
  summaryAgent,
  TranscriptionOutputSchema,
  tableAgent,
  transcriptionAgent,
  webSearchAgent,
};
