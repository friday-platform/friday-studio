import { BbOutputSchema, bbAgent } from "./bb/agent.ts";
import { ClaudeCodeOutputSchema, claudeCodeAgent } from "./claude-code/agent.ts";
import { FathomOutputSchema, fathomGetTranscriptAgent } from "./fathom-ai/get-transcript.ts";
import { GhOutputSchema, ghAgent } from "./gh/agent.ts";
import { HubSpotOutputSchema, hubspotAgent } from "./hubspot/index.ts";
import { ImageGenerationOutputSchema, imageGenerationAgent } from "./image-generation/agent.ts";
import { type DiscoveredImages, discoverImageFiles } from "./image-generation/discovery.ts";
import { JiraOutputSchema, jiraAgent } from "./jira/agent.ts";
import { knowledgeHybridAgent } from "./knowledge/agent.ts";
import { KnowledgeOutputSchema } from "./knowledge/shared.ts";
import { SlackOutputSchema, slackCommunicatorAgent } from "./slack/communicator.ts";
import { SummaryOutputSchema, summaryAgent } from "./summary.ts";
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
  discoverableBundledAgents,
} from "./registry.ts";

export type { BrowserAgentResult, DiscoveredImages, WebAgentResult };
export {
  BbOutputSchema,
  BrowserOutputSchema,
  bbAgent,
  browserAgent,
  ClaudeCodeOutputSchema,
  claudeCodeAgent,
  discoverImageFiles,
  FathomOutputSchema,
  fathomGetTranscriptAgent,
  GhOutputSchema,
  ghAgent,
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
  SummaryOutputSchema,
  slackCommunicatorAgent,
  summaryAgent,
  WebOutputSchema,
  webAgent,
  webSearchAgent,
};
