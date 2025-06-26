/**
 * Condition Node for Behavior Trees
 * Evaluates a condition and returns SUCCESS or FAILURE
 */

import { BaseNode, NodeContext, NodeStatus } from "./base-node.ts";

export interface ConditionNodeConfig {
  id: string;
  name?: string;
  description?: string;
  // Condition to evaluate
  condition: string;
  // Optional: expected value
  expectedValue?: unknown;
  // Optional: comparison operator
  operator?: "equals" | "not_equals" | "greater" | "less" | "contains" | "regex";
  // Optional: path to value in context (dot notation)
  valuePath?: string;
}

export class ConditionNode extends BaseNode {
  constructor(config: ConditionNodeConfig) {
    super(config);
  }

  execute(context: NodeContext): Promise<NodeStatus> {
    const config = this.config as ConditionNodeConfig;
    this.log(`Evaluating condition: ${config.condition}`);

    try {
      const result = this.evaluateCondition(config, context);
      const status = result ? NodeStatus.SUCCESS : NodeStatus.FAILURE;

      this.log(`Condition evaluated to: ${result} (${status})`);
      return Promise.resolve(status);
    } catch (error) {
      this.log(`Condition evaluation failed: ${error}`, "error");
      return Promise.resolve(NodeStatus.FAILURE);
    }
  }

  private evaluateCondition(
    config: ConditionNodeConfig,
    context: NodeContext,
  ): boolean {
    // Handle simple boolean conditions
    if (config.condition === "true") return true;
    if (config.condition === "false") return false;

    // Handle context-based conditions
    if (config.valuePath) {
      const value = this.getValueFromPath(context, config.valuePath);
      return this.compareValues(value, config.expectedValue, config.operator || "equals");
    }

    // Handle predefined condition patterns
    return this.evaluatePredefinedCondition(config.condition, context);
  }

  private getValueFromPath(context: NodeContext, path: string): unknown {
    const parts = path.split(".");
    let current: unknown = context;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      if (typeof current === "object" && current !== null) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  private compareValues(actual: unknown, expected: unknown, operator: string): boolean {
    switch (operator) {
      case "equals":
        return actual === expected;

      case "not_equals":
        return actual !== expected;

      case "greater":
        return Number(actual) > Number(expected);

      case "less":
        return Number(actual) < Number(expected);

      case "contains":
        if (typeof actual === "string" && typeof expected === "string") {
          return actual.includes(expected);
        }
        if (Array.isArray(actual)) {
          return actual.includes(expected);
        }
        return false;

      case "regex":
        if (typeof actual === "string" && typeof expected === "string") {
          const regex = new RegExp(expected);
          return regex.test(actual);
        }
        return false;

      default:
        this.log(`Unknown operator: ${operator}`, "warn");
        return actual === expected;
    }
  }

  private evaluatePredefinedCondition(condition: string, context: NodeContext): boolean {
    switch (condition.toLowerCase()) {
      // Agent-related conditions
      case "has_previous_output":
        return context.currentInput !== undefined && context.currentInput !== null;

      case "is_first_agent":
        return !Object.prototype.hasOwnProperty.call(context.globalState, "previousAgentOutput");

      case "is_error_present": {
        const input = context.currentInput;
        if (input && typeof input === "object") {
          // Check if the input object contains error-related strings
          const inputStr = JSON.stringify(input).toLowerCase();
          return inputStr.includes("error") || inputStr.includes("fail");
        }
        return false;
      }

      // Risk assessment conditions
      case "risk_score_high": {
        const riskScore = context.globalState.riskScore;
        return typeof riskScore === "number" && riskScore > 0.8;
      }

      case "risk_score_medium": {
        const riskScore = context.globalState.riskScore;
        return typeof riskScore === "number" && riskScore > 0.5 && riskScore <= 0.8;
      }

      case "risk_score_low": {
        const riskScore = context.globalState.riskScore;
        return typeof riskScore === "number" ? riskScore <= 0.5 : true; // Default to low risk if not set
      }

      // Data size conditions
      case "input_large": {
        const inputSize = JSON.stringify(context.currentInput || {}).length;
        return inputSize > 1000;
      }

      case "input_small": {
        const inputSize2 = JSON.stringify(context.currentInput || {}).length;
        return inputSize2 <= 100;
      }

      default:
        this.log(`Unknown predefined condition: ${condition}`, "warn");
        return false;
    }
  }

  // Validate condition node
  override validate(): { valid: boolean; errors: string[] } {
    const baseValidation = super.validate();
    const errors = [...baseValidation.errors];
    const config = this.config as ConditionNodeConfig;

    if (!config.condition) {
      errors.push("Condition node must specify a condition");
    }

    if (config.valuePath && !config.expectedValue && config.operator !== "equals") {
      errors.push("Condition node with valuePath should specify expectedValue for comparison");
    }

    if (
      config.operator &&
      !["equals", "not_equals", "greater", "less", "contains", "regex"].includes(config.operator)
    ) {
      errors.push(`Invalid operator: ${config.operator}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
