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
import { ImageGenerationOutputSchema, imageGenerationAgent } from "./image-generation/agent.ts";
import { type DiscoveredImages, discoverImageFiles } from "./image-generation/discovery.ts";
import { JiraOutputSchema, jiraAgent } from "./jira/agent.ts";
import { knowledgeHybridAgent } from "./knowledge/agent.ts";
import { KnowledgeOutputSchema } from "./knowledge/shared.ts";
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
import {
  type BrowserAgentResult,
  BrowserOutputSchema,
  browserAgent,
  ResearchOutputSchema,
  webSearchAgent,
} from "./web/compat.ts";
import { type WebAgentResult, WebOutputSchema, webAgent } from "./web/index.ts";

export type { KnowledgeResult } from "./knowledge/shared.ts";
export {
  type BundledAgentConfigField,
  type BundledAgentRegistryEntry,
  bundledAgents,
  bundledAgentsRegistry,
} from "./registry.ts";

export type {
  BrowserAgentResult,
  DataAnalystResult,
  DiscoveredAudio,
  DiscoveredImages,
  QueryExecution,
  SnowflakeAnalystResult,
  WebAgentResult,
};
export {
  BbOutputSchema,
  BrowserOutputSchema,
  bbAgent,
  browserAgent,
  ClaudeCodeOutputSchema,
  CsvFilterSamplerOutputSchema,
  claudeCodeAgent,
  csvFilterSamplerAgent,
  dataAnalystAgent,
  discoverAudioFiles,
  discoverImageFiles,
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
  ImageGenerationOutputSchema,
  imageGenerationAgent,
  JiraOutputSchema,
  jiraAgent,
  KnowledgeOutputSchema,
  knowledgeHybridAgent,
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
  WebOutputSchema,
  webAgent,
  webSearchAgent,
};
