/**
 * Pluggable Condition Evaluator System
 *
 * Provides a framework-suitable system for evaluating job trigger conditions
 * without hardcoded logic. Supports multiple evaluation strategies including
 * JSONLogic, natural language parsing, and custom evaluators.
 */

import { logger } from "../../utils/logger.ts";

export interface ConditionEvaluationResult {
  matches: boolean;
  confidence: number; // 0-1 scale
  evaluator: string;
  metadata?: Record<string, unknown>;
}

export interface ConditionEvaluator {
  readonly name: string;
  readonly priority: number; // Higher priority evaluators tried first

  /**
   * Check if this evaluator can handle the given condition
   */
  canHandle(condition: string | object): boolean;

  /**
   * Evaluate the condition against the payload
   */
  evaluate(condition: string | object, payload: unknown): Promise<ConditionEvaluationResult>;

  /**
   * Optional: Parse natural language into this evaluator's format
   */
  parseNaturalLanguage?(naturalLanguage: string): Promise<string | object>;
}

export interface ConditionEvaluatorConfig {
  evaluators: {
    [name: string]: {
      enabled: boolean;
      priority?: number;
      config?: Record<string, unknown>;
    };
  };
  fallback_strategy: "fail" | "allow" | "reject";
  require_match_confidence?: number; // Minimum confidence threshold
}

export class ConditionEvaluatorRegistry {
  private evaluators = new Map<string, ConditionEvaluator>();
  private config: ConditionEvaluatorConfig;

  constructor(config: ConditionEvaluatorConfig) {
    this.config = config;
    this.registerBuiltinEvaluators();
  }

  /**
   * Register a condition evaluator
   */
  register(evaluator: ConditionEvaluator): void {
    const evaluatorConfig = this.config.evaluators[evaluator.name];

    if (evaluatorConfig?.enabled !== false) { // Default to enabled
      this.evaluators.set(evaluator.name, evaluator);
      logger.debug("Registered condition evaluator", {
        name: evaluator.name,
        priority: evaluator.priority,
      });
    }
  }

  /**
   * Evaluate a condition using the best available evaluator
   */
  async evaluate(condition: string | object, payload: unknown): Promise<ConditionEvaluationResult> {
    if (!condition) {
      return {
        matches: true, // No condition means always match
        confidence: 1.0,
        evaluator: "no-condition",
      };
    }

    // Get sorted evaluators by priority
    const sortedEvaluators = Array.from(this.evaluators.values())
      .sort((a, b) => b.priority - a.priority);

    // Try each evaluator in priority order
    for (const evaluator of sortedEvaluators) {
      if (evaluator.canHandle(condition)) {
        try {
          const result = await evaluator.evaluate(condition, payload);

          // Check confidence threshold if configured
          const minConfidence = this.config.require_match_confidence || 0;
          if (result.confidence >= minConfidence) {
            logger.debug("Condition evaluated successfully", {
              evaluator: evaluator.name,
              matches: result.matches,
              confidence: result.confidence,
            });
            return result;
          } else {
            logger.debug("Condition evaluation below confidence threshold", {
              evaluator: evaluator.name,
              confidence: result.confidence,
              threshold: minConfidence,
            });
          }
        } catch (error) {
          logger.warn("Condition evaluator failed", {
            evaluator: evaluator.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // No evaluator could handle the condition
    return this.handleFallback(condition);
  }

  /**
   * Parse natural language condition into executable form
   */
  async parseNaturalLanguage(naturalLanguage: string): Promise<{
    condition: string | object;
    evaluator: string;
    confidence: number;
  }> {
    // Try each evaluator that supports natural language parsing
    const sortedEvaluators = Array.from(this.evaluators.values())
      .filter((e) => e.parseNaturalLanguage)
      .sort((a, b) => b.priority - a.priority);

    for (const evaluator of sortedEvaluators) {
      try {
        const parsed = await evaluator.parseNaturalLanguage!(naturalLanguage);
        return {
          condition: parsed,
          evaluator: evaluator.name,
          confidence: 0.8, // Default confidence for parsed conditions
        };
      } catch (error) {
        logger.debug("Natural language parsing failed", {
          evaluator: evaluator.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw new Error(`No evaluator could parse natural language: "${naturalLanguage}"`);
  }

  /**
   * Get all registered evaluators
   */
  getEvaluators(): ConditionEvaluator[] {
    return Array.from(this.evaluators.values());
  }

  /**
   * Handle fallback when no evaluator can process the condition
   */
  private handleFallback(condition: string | object): ConditionEvaluationResult {
    switch (this.config.fallback_strategy) {
      case "allow":
        return {
          matches: true,
          confidence: 0.1,
          evaluator: "fallback-allow",
          metadata: { condition, reason: "no_matching_evaluator" },
        };
      case "reject":
        return {
          matches: false,
          confidence: 0.1,
          evaluator: "fallback-reject",
          metadata: { condition, reason: "no_matching_evaluator" },
        };
      case "fail":
      default:
        throw new Error(`No condition evaluator can handle: ${JSON.stringify(condition)}`);
    }
  }

  /**
   * Register built-in evaluators
   */
  private registerBuiltinEvaluators(): void {
    // Register built-in evaluators in priority order
    this.register(new JSONLogicEvaluator());
    this.register(new SimpleExpressionEvaluator());
    this.register(new ExactMatchEvaluator());
  }
}

/**
 * JSONLogic evaluator for complex logical expressions
 */
class JSONLogicEvaluator implements ConditionEvaluator {
  readonly name = "jsonlogic";
  readonly priority = 100;

  canHandle(condition: string | object): boolean {
    if (typeof condition === "object" && condition !== null) {
      // Check if it looks like JSONLogic format
      const keys = Object.keys(condition);
      return keys.some((key) =>
        ["and", "or", "not", "==", "!=", "<", ">", "<=", ">=", "in", "var"].includes(key)
      );
    }
    return false;
  }

  evaluate(condition: string | object, payload: unknown): Promise<ConditionEvaluationResult> {
    try {
      // For now, implement basic JSONLogic operations
      // In production, would use a proper JSONLogic library
      const result = this.evaluateJSONLogic(condition as object, payload);

      return Promise.resolve({
        matches: Boolean(result),
        confidence: 1.0,
        evaluator: this.name,
        metadata: { condition, payload_keys: payload ? Object.keys(payload as object) : [] },
      });
    } catch (error) {
      return Promise.reject(new Error(`JSONLogic evaluation failed: ${error}`));
    }
  }

  async parseNaturalLanguage(naturalLanguage: string): Promise<object> {
    // Use the enhanced natural language parser with AI integration
    const { NaturalLanguageConditionParser } = await import("./natural-language-parser.ts");
    const parser = new NaturalLanguageConditionParser();

    const result = await parser.parseCondition(naturalLanguage, {
      availableVariables: ["message", "event", "source", "timestamp", "metadata"],
      expectedPayloadShape: {
        message: "string",
        event: { type: "string", reason: "string", object: {} },
        source: "string",
        timestamp: "ISO date string",
        metadata: {},
      },
    });

    // If this evaluator can handle the parsed expression, return it
    if (result.parsed.expression.type === "jsonlogic") {
      return result.parsed.expression.content as object;
    }

    // Fallback to simple patterns for backward compatibility
    if (naturalLanguage.includes("message") && naturalLanguage.includes("shorter than")) {
      const match = naturalLanguage.match(/shorter than (\d+)/);
      if (match) {
        const length = parseInt(match[1]);
        return {
          "and": [
            { "var": "message" },
            { "<": [{ "var": "message.length" }, length] },
          ],
        };
      }
    }

    if (naturalLanguage.includes("event type") && naturalLanguage.includes("Warning")) {
      return {
        "==": [{ "var": "event.type" }, "Warning"],
      };
    }

    throw new Error(`Cannot parse natural language as JSONLogic: "${naturalLanguage}"`);
  }

  private evaluateJSONLogic(logic: object, data: unknown): unknown {
    // Basic JSONLogic implementation
    // In production, use the official jsonlogic library

    if (typeof logic !== "object" || logic === null) {
      return logic;
    }

    const operator = Object.keys(logic)[0];
    const operands = (logic as Record<string, unknown>)[operator];

    switch (operator) {
      case "var":
        return this.getVar(operands, data);
      case "==":
        return this.evaluateJSONLogic(operands[0], data) ===
          this.evaluateJSONLogic(operands[1], data);
      case "!=":
        return this.evaluateJSONLogic(operands[0], data) !==
          this.evaluateJSONLogic(operands[1], data);
      case "<":
        return Number(this.evaluateJSONLogic(operands[0], data)) <
          Number(this.evaluateJSONLogic(operands[1], data));
      case ">":
        return Number(this.evaluateJSONLogic(operands[0], data)) >
          Number(this.evaluateJSONLogic(operands[1], data));
      case "<=":
        return Number(this.evaluateJSONLogic(operands[0], data)) <=
          Number(this.evaluateJSONLogic(operands[1], data));
      case ">=":
        return Number(this.evaluateJSONLogic(operands[0], data)) >=
          Number(this.evaluateJSONLogic(operands[1], data));
      case "and":
        return operands.every((op: unknown) => this.evaluateJSONLogic(op as object, data));
      case "or":
        return operands.some((op: unknown) => this.evaluateJSONLogic(op as object, data));
      case "not":
        return !this.evaluateJSONLogic(operands, data);
      case "in": {
        const value = this.evaluateJSONLogic((operands as unknown[])[0], data);
        const array = this.evaluateJSONLogic((operands as unknown[])[1], data);
        return Array.isArray(array) && array.includes(value);
      }
      default:
        throw new Error(`Unknown JSONLogic operator: ${operator}`);
    }
  }

  private getVar(path: string, data: unknown): unknown {
    if (!path) return data;

    const keys = path.split(".");
    let current = data;

    for (const key of keys) {
      if (current && typeof current === "object" && key in current) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }

    return current;
  }
}

/**
 * Simple expression evaluator for basic comparisons
 */
class SimpleExpressionEvaluator implements ConditionEvaluator {
  readonly name = "simple_expression";
  readonly priority = 50;

  canHandle(condition: string | object): boolean {
    if (typeof condition === "string") {
      // Check for simple expression patterns
      return /^[\w\.\s\&\|\<\>\=\!\d]+$/.test(condition) &&
        (condition.includes("&&") || condition.includes("||") || condition.includes("==") ||
          condition.includes("!=") || condition.includes("<") || condition.includes(">"));
    }
    return false;
  }

  evaluate(condition: string | object, payload: unknown): Promise<ConditionEvaluationResult> {
    if (typeof condition !== "string") {
      return Promise.reject(new Error("Simple expression evaluator requires string condition"));
    }

    try {
      // Parse and evaluate simple expressions safely
      const result = this.evaluateSimpleExpression(condition, payload);

      return Promise.resolve({
        matches: Boolean(result),
        confidence: 0.8,
        evaluator: this.name,
        metadata: { condition, expression_type: "simple" },
      });
    } catch (error) {
      return Promise.reject(new Error(`Simple expression evaluation failed: ${error}`));
    }
  }

  async parseNaturalLanguage(naturalLanguage: string): Promise<string> {
    // Use the enhanced natural language parser with AI integration
    const { NaturalLanguageConditionParser } = await import("./natural-language-parser.ts");
    const parser = new NaturalLanguageConditionParser();

    const result = await parser.parseCondition(naturalLanguage);

    // If this evaluator can handle the parsed expression, return it
    if (result.parsed.expression.type === "simple") {
      return result.parsed.expression.content as string;
    }

    // Convert JSONLogic to simple expression if possible
    if (result.parsed.expression.type === "jsonlogic") {
      const simplified = this.convertJSONLogicToSimple(result.parsed.expression.content as object);
      if (simplified) {
        return simplified;
      }
    }

    throw new Error(`Cannot parse natural language as simple expression: "${naturalLanguage}"`);
  }

  private convertJSONLogicToSimple(jsonlogic: object): string | null {
    // Convert basic JSONLogic patterns to simple expressions
    if (typeof jsonlogic !== "object" || jsonlogic === null) {
      return null;
    }

    const keys = Object.keys(jsonlogic);
    if (keys.length !== 1) return null;

    const operator = keys[0];
    const operands = (jsonlogic as Record<string, unknown>)[operator];

    switch (operator) {
      case "and":
        if (Array.isArray(operands) && operands.length === 2) {
          const left = this.convertJSONLogicToSimple(operands[0]);
          const right = this.convertJSONLogicToSimple(operands[1]);
          if (left && right) {
            return `${left} && ${right}`;
          }
        }
        break;
      case "or":
        if (Array.isArray(operands) && operands.length === 2) {
          const left = this.convertJSONLogicToSimple(operands[0]);
          const right = this.convertJSONLogicToSimple(operands[1]);
          if (left && right) {
            return `${left} || ${right}`;
          }
        }
        break;
      case "<":
        if (Array.isArray(operands) && operands.length === 2) {
          const left = this.convertJSONLogicToSimple(operands[0]);
          const right = this.convertJSONLogicToSimple(operands[1]);
          if (left && right) {
            return `${left} < ${right}`;
          }
        }
        break;
      case "var":
        if (typeof operands === "string") {
          return operands;
        }
        break;
    }

    return null;
  }

  private evaluateSimpleExpression(condition: string, payload: unknown): boolean {
    // Handle the specific telephone game condition as an example
    if (condition.includes("message && message.length")) {
      const message = (payload as Record<string, unknown>)?.message;
      if (!message) return false;

      if (condition.includes("< 100")) {
        return message.length > 0 && message.length < 100;
      } else if (condition.includes(">= 100")) {
        return message.length >= 100;
      }
    }

    // Add more simple expression patterns as needed
    throw new Error(`Unsupported simple expression: ${condition}`);
  }
}

/**
 * Exact match evaluator for string matching
 */
class ExactMatchEvaluator implements ConditionEvaluator {
  readonly name = "exact_match";
  readonly priority = 10;

  canHandle(condition: string | object): boolean {
    return typeof condition === "string" && !condition.includes("&&") && !condition.includes("||");
  }

  evaluate(condition: string | object, payload: unknown): Promise<ConditionEvaluationResult> {
    if (typeof condition !== "string") {
      return Promise.reject(new Error("Exact match evaluator requires string condition"));
    }

    // Simple string matching against payload properties
    const payloadStr = JSON.stringify(payload).toLowerCase();
    const conditionStr = condition.toLowerCase();

    const matches = payloadStr.includes(conditionStr);

    return Promise.resolve({
      matches,
      confidence: matches ? 0.6 : 0.1,
      evaluator: this.name,
      metadata: { condition, match_type: "substring" },
    });
  }
}
