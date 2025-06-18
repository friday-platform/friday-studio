/**
 * Signal Processing Module
 * Intelligent signal analysis, task generation, and agent selection
 */

export { SignalAnalyzer } from "./signal-analyzer.ts";
export { TaskGenerator } from "./task-generator.ts";
export { type AgentInfo, AgentSelector } from "./agent-selector.ts";
export { type ProcessingResult, SignalProcessor } from "./signal-processor.ts";

export type {
  AgentCapabilities,
  AgentRoutingRule,
  EnhancedTask,
  EntityExtraction,
  SignalAnalysis,
  SignalPattern,
  SignalProcessingConfig,
  SignalTrigger,
  TaskTemplate,
} from "./types.ts";
