/**
 * Signal Processing Module
 * Intelligent signal analysis, task generation, and agent selection
 */

export { SignalAnalyzer } from "./signal-analyzer.ts";
export { TaskGenerator } from "./task-generator.ts";
export { AgentSelector, type AgentInfo } from "./agent-selector.ts";
export { SignalProcessor, type ProcessingResult } from "./signal-processor.ts";

export type {
  SignalAnalysis,
  SignalPattern,
  SignalTrigger,
  EntityExtraction,
  TaskTemplate,
  EnhancedTask,
  AgentCapabilities,
  SignalProcessingConfig,
  AgentRoutingRule,
} from "./types.ts";