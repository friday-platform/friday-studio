import { ClaudeCodeOutputSchema, claudeCodeAgent } from "./claude-code/agent.ts";
import { CsvFilterSamplerOutputSchema, csvFilterSamplerAgent } from "./csv/filter.ts";
import { type DataAnalystResult, dataAnalystAgent } from "./data-analyst/agent.ts";
import type { QueryExecution } from "./data-analyst/sql-tools.ts";
import { EmailOutputSchema, emailAgent } from "./email/communicator.ts";
import { FathomOutputSchema, fathomGetTranscriptAgent } from "./fathom-ai/get-transcript.ts";
import { GoogleCalendarOutputSchema, googleCalendarAgent } from "./google/calendar.ts";
import { SlackOutputSchema, slackCommunicatorAgent } from "./slack/communicator.ts";
import { SummaryOutputSchema, summaryAgent } from "./summary.ts";
import { tableAgent } from "./table.ts";
import { TranscriptionOutputSchema, transcriptionAgent } from "./transcription/agent.ts";
import { type DiscoveredAudio, discoverAudioFiles } from "./transcription/discovery.ts";
import { ResearchOutputSchema, webSearchAgent } from "./web-search/web-search.ts";

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
  discoverAudioFiles,
  transcriptionAgent,
  ClaudeCodeOutputSchema,
  CsvFilterSamplerOutputSchema,
  EmailOutputSchema,
  FathomOutputSchema,
  GoogleCalendarOutputSchema,
  ResearchOutputSchema,
  SlackOutputSchema,
  SummaryOutputSchema,
  TranscriptionOutputSchema,
};

export type { DataAnalystResult, DiscoveredAudio, QueryExecution };

export {
  type BundledAgentConfigField,
  type BundledAgentRegistryEntry,
  bundledAgents,
  bundledAgentsRegistry,
} from "./registry.ts";
