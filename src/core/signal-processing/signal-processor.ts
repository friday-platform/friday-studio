/**
 * Main Signal Processor
 * Orchestrates signal analysis, task generation, and agent selection
 */

import { logger } from "../../utils/logger.ts";
import { SignalAnalyzer } from "./signal-analyzer.ts";
import { TaskGenerator } from "./task-generator.ts";
import { type AgentInfo, AgentSelector } from "./agent-selector.ts";
import type { AgentCapabilities, EnhancedTask, SignalProcessingConfig } from "./types.ts";

export interface ProcessingResult {
  task: EnhancedTask;
  selectedAgent: AgentInfo | null;
  processingTime: number;
}

export class SignalProcessor {
  private analyzer: SignalAnalyzer;
  private taskGenerator: TaskGenerator;
  private agentSelector: AgentSelector;

  constructor(config?: SignalProcessingConfig) {
    this.analyzer = new SignalAnalyzer(config?.patterns || []);
    this.taskGenerator = new TaskGenerator(config?.taskTemplates || []);
    this.agentSelector = new AgentSelector(config?.agentRouting || []);

    logger.info("Signal processor initialized", {
      patterns: config?.patterns?.length || 0,
      templates: config?.taskTemplates?.length || 0,
      routingRules: config?.agentRouting?.length || 0,
    });
  }

  /**
   * Process a signal end-to-end: analyze → generate task → select agent
   */
  async processSignal(
    // deno-lint-ignore no-explicit-any
    signal: any,
    availableAgents: AgentInfo[],
  ): Promise<ProcessingResult> {
    const startTime = Date.now();

    logger.info("Starting signal processing", {
      signalSource: signal.source,
      availableAgents: availableAgents.length,
    });

    try {
      // Step 1: Analyze signal
      const analysis = await this.analyzer.analyze(signal);

      // Step 2: Generate task
      const task = await this.taskGenerator.createTask(signal, analysis);

      // Step 3: Select agent
      const selectedAgent = this.agentSelector.selectAgent(task, availableAgents);

      const processingTime = Date.now() - startTime;

      logger.info("Signal processing completed", {
        processingTime,
        taskDescription: task.description,
        selectedAgent: selectedAgent?.id || "none",
        priority: task.priority,
        complexity: task.estimatedComplexity,
      });

      return {
        task,
        selectedAgent,
        processingTime,
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;

      logger.error("Signal processing failed", {
        error: error instanceof Error ? error.message : String(error),
        processingTime,
        signalSource: signal.source,
      });

      throw error;
    }
  }

  /**
   * Register agent capabilities for better selection
   */
  registerAgentCapabilities(agentId: string, capabilities: AgentCapabilities): void {
    this.agentSelector.registerAgentCapabilities(agentId, capabilities);
  }

  /**
   * Update configuration
   */
  updateConfiguration(config: SignalProcessingConfig): void {
    if (config.patterns) {
      this.analyzer.addPatterns(config.patterns);
    }

    if (config.taskTemplates) {
      this.taskGenerator.addTemplates(config.taskTemplates);
    }

    if (config.agentRouting) {
      this.agentSelector.addRoutingRules(config.agentRouting);
    }

    logger.info("Signal processor configuration updated", {
      patterns: config.patterns?.length || 0,
      templates: config.taskTemplates?.length || 0,
      routingRules: config.agentRouting?.length || 0,
    });
  }

  /**
   * Get processing statistics
   */
  getProcessingStats(): {
    analyzer: { totalPatterns: number };
    taskGenerator: { totalTemplates: number };
    agentSelector: {
      totalRules: number;
      registeredAgents: number;
      capabilityDomains: string[];
    };
  } {
    return {
      analyzer: {
        totalPatterns: (this.analyzer as any).patterns?.length || 0,
      },
      taskGenerator: {
        totalTemplates: (this.taskGenerator as any).templates?.length || 0,
      },
      agentSelector: this.agentSelector.getSelectionStats(),
    };
  }
}
