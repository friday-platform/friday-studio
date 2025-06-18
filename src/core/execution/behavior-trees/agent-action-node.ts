/**
 * Agent Action Node for Behavior Trees
 * Executes a specific agent with given task and input
 */

import { BaseNode, NodeContext, NodeStatus } from "./base-node.ts";

export interface AgentActionNodeConfig {
  id: string;
  name?: string;
  description?: string;
  // Agent to execute
  agentId: string;
  // Task to give to the agent
  task: string;
  // Input source configuration
  inputSource?: "signal" | "previous" | "global" | "custom";
  // Custom input (if inputSource is "custom")
  customInput?: any;
  // Global state key to store output
  outputKey?: string;
  // Success criteria
  successCriteria?: {
    // Minimum output length
    minOutputLength?: number;
    // Required strings in output
    requiredStrings?: string[];
    // Forbidden strings in output
    forbiddenStrings?: string[];
    // Output format validation
    validateJSON?: boolean;
  };
}

export class AgentActionNode extends BaseNode {
  constructor(config: AgentActionNodeConfig) {
    super(config);
  }

  async execute(context: NodeContext): Promise<NodeStatus> {
    const config = this.config as AgentActionNodeConfig;
    this.log(`Executing agent: ${config.agentId} with task: ${config.task}`);

    if (!context.agentExecutor) {
      this.log("No agent executor provided in context", "error");
      return NodeStatus.FAILURE;
    }

    try {
      // Determine input based on inputSource
      const input = this.determineInput(config, context);
      this.log(`Agent input determined: ${JSON.stringify(input).substring(0, 200)}...`);

      // Execute the agent
      const startTime = Date.now();
      const output = await context.agentExecutor(config.agentId, config.task, input);
      const duration = Date.now() - startTime;

      this.log(`Agent execution completed in ${duration}ms`);

      // Validate output if criteria provided
      if (config.successCriteria) {
        const validationResult = this.validateOutput(output, config.successCriteria);
        if (!validationResult.valid) {
          this.log(`Output validation failed: ${validationResult.errors.join(", ")}`, "warn");
          return NodeStatus.FAILURE;
        }
      }

      // Store output in global state if specified
      if (config.outputKey) {
        context.globalState[config.outputKey] = output;
        this.log(`Stored output in global state: ${config.outputKey}`);
      }

      // Update current input for next node
      context.currentInput = output;

      this.log(`Agent execution successful`);
      return NodeStatus.SUCCESS;
    } catch (error) {
      this.log(`Agent execution failed: ${error}`, "error");
      return NodeStatus.FAILURE;
    }
  }

  private determineInput(config: AgentActionNodeConfig, context: NodeContext): any {
    switch (config.inputSource) {
      case "signal":
        // Use original signal payload
        return context.globalState.originalPayload || context.currentInput;

      case "previous":
        // Use output from previous agent
        return context.currentInput;

      case "global":
        // Use entire global state
        return context.globalState;

      case "custom":
        // Use custom input specified in config
        return config.customInput;

      default:
        // Default to current input
        return context.currentInput;
    }
  }

  private validateOutput(
    output: any,
    criteria: NonNullable<AgentActionNodeConfig["successCriteria"]>,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Convert output to string for validation
    const outputStr = typeof output === "string" ? output : JSON.stringify(output);

    // Check minimum length
    if (criteria.minOutputLength && outputStr.length < criteria.minOutputLength) {
      errors.push(`Output too short: ${outputStr.length} < ${criteria.minOutputLength}`);
    }

    // Check required strings
    if (criteria.requiredStrings) {
      for (const required of criteria.requiredStrings) {
        if (!outputStr.toLowerCase().includes(required.toLowerCase())) {
          errors.push(`Missing required string: "${required}"`);
        }
      }
    }

    // Check forbidden strings
    if (criteria.forbiddenStrings) {
      for (const forbidden of criteria.forbiddenStrings) {
        if (outputStr.toLowerCase().includes(forbidden.toLowerCase())) {
          errors.push(`Contains forbidden string: "${forbidden}"`);
        }
      }
    }

    // Validate JSON if required
    if (criteria.validateJSON) {
      try {
        if (typeof output === "string") {
          JSON.parse(output);
        }
        // If output is already an object, it's valid JSON-like
      } catch (error) {
        errors.push("Output is not valid JSON");
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // Validate agent action node
  override validate(): { valid: boolean; errors: string[] } {
    const baseValidation = super.validate();
    const errors = [...baseValidation.errors];
    const config = this.config as AgentActionNodeConfig;

    if (!config.agentId) {
      errors.push("Agent action node must specify an agentId");
    }

    if (!config.task) {
      errors.push("Agent action node must specify a task");
    }

    if (config.inputSource === "custom" && config.customInput === undefined) {
      errors.push("Agent action node with custom inputSource must provide customInput");
    }

    if (config.successCriteria?.minOutputLength && config.successCriteria.minOutputLength < 0) {
      errors.push("Minimum output length must be >= 0");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
