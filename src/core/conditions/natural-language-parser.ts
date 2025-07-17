/**
 * Natural Language Condition Parser
 *
 * Converts natural language conditions into safe, executable expressions
 * using AI parsing with human-in-the-loop confirmation for accuracy.
 */

import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { logger } from "../../utils/logger.ts";

// Schema for parsed condition structure
const ConditionParseSchema = z.object({
  expression: z.object({
    type: z.enum(["jsonlogic", "simple", "exact"]),
    content: z.union([z.object({}), z.string()]), // JSONLogic object or string expression
  }),
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
  variables: z.array(z.string()),
  operators: z.array(z.string()),
  examples: z.array(z.object({
    input: z.object({}),
    expected: z.boolean(),
    reasoning: z.string(),
  })),
});

export type ParsedCondition = z.infer<typeof ConditionParseSchema>;

export interface NaturalLanguageParseResult {
  parsed: ParsedCondition;
  requiresConfirmation: boolean;
  alternativeInterpretations?: ParsedCondition[];
}

export interface ConfirmationRequest {
  id: string;
  originalText: string;
  parsed: ParsedCondition;
  alternatives: ParsedCondition[];
  timestamp: number;
  workspaceId: string;
  userId?: string;
}

export class NaturalLanguageConditionParser {
  private anthropic;
  private pendingConfirmations = new Map<string, ConfirmationRequest>();
  private confirmedParsings = new Map<string, ParsedCondition>();
  private config: {
    model: string;
    confidenceThreshold: number;
    requireConfirmationBelow: number;
    maxAlternatives: number;
  };

  constructor(config?: Partial<typeof this.config>) {
    this.config = {
      model: "claude-3-7-sonnet-latest",
      confidenceThreshold: 0.8,
      requireConfirmationBelow: 0.9,
      maxAlternatives: 3,
      ...config,
    };

    this.anthropic = createAnthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    });
  }

  /**
   * Parse natural language condition into executable expression
   */
  async parseCondition(
    naturalLanguage: string,
    context?: {
      workspaceId?: string;
      userId?: string;
      availableVariables?: string[];
      expectedPayloadShape?: object;
    },
  ): Promise<NaturalLanguageParseResult> {
    const trimmedText = naturalLanguage.trim();

    // Check if we've already confirmed this exact parsing
    const cachedResult = this.confirmedParsings.get(trimmedText);
    if (cachedResult) {
      logger.debug("Using cached confirmed condition parsing", {
        condition: trimmedText,
        type: cachedResult.expression.type,
      });
      return {
        parsed: cachedResult,
        requiresConfirmation: false,
      };
    }

    logger.info("Parsing natural language condition with AI", {
      condition: trimmedText,
      workspaceId: context?.workspaceId,
      availableVariables: context?.availableVariables?.length || 0,
    });

    try {
      // Generate primary interpretation
      const primary = await this.generateConditionParsing(trimmedText, context);

      // Generate alternative interpretations if confidence is low
      const alternatives: ParsedCondition[] = [];
      if (primary.confidence < this.config.requireConfirmationBelow) {
        logger.debug("Generating alternative interpretations due to low confidence", {
          primaryConfidence: primary.confidence,
          threshold: this.config.requireConfirmationBelow,
        });

        for (let i = 0; i < this.config.maxAlternatives; i++) {
          try {
            const alternative = await this.generateConditionParsing(
              trimmedText,
              context,
              {
                avoidInterpretation: primary,
                alternativeNumber: i + 1,
              },
            );
            if (alternative.explanation !== primary.explanation) {
              alternatives.push(alternative);
            }
          } catch (error) {
            logger.debug(`Failed to generate alternative ${i + 1}`, { error });
            break;
          }
        }
      }

      const requiresConfirmation = primary.confidence < this.config.requireConfirmationBelow;

      if (requiresConfirmation && context?.workspaceId) {
        // Create confirmation request
        const confirmationId = crypto.randomUUID();
        const confirmationRequest: ConfirmationRequest = {
          id: confirmationId,
          originalText: trimmedText,
          parsed: primary,
          alternatives,
          timestamp: Date.now(),
          workspaceId: context.workspaceId,
          userId: context.userId,
        };

        this.pendingConfirmations.set(confirmationId, confirmationRequest);

        logger.info("Created confirmation request for condition parsing", {
          confirmationId,
          condition: trimmedText,
          confidence: primary.confidence,
          alternativeCount: alternatives.length,
        });
      }

      return {
        parsed: primary,
        requiresConfirmation,
        alternativeInterpretations: alternatives.length > 0 ? alternatives : undefined,
      };
    } catch (error) {
      logger.error("Failed to parse natural language condition", {
        condition: trimmedText,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to parse condition: ${error}`);
    }
  }

  /**
   * Generate condition parsing using AI
   */
  private async generateConditionParsing(
    naturalLanguage: string,
    context?: {
      availableVariables?: string[];
      expectedPayloadShape?: object;
    },
    options?: {
      avoidInterpretation?: ParsedCondition;
      alternativeNumber?: number;
    },
  ): Promise<ParsedCondition> {
    const systemPrompt =
      `You are an expert at converting natural language conditions into safe, executable expressions for a signal processing system.

Available expression types:
1. "jsonlogic" - Use JSONLogic format for complex logical operations (recommended for most conditions)
2. "simple" - Use simple string expressions like "message && message.length < 100"
3. "exact" - Use exact string matching for basic keyword detection

Available variables in signal payload:
${context?.availableVariables?.join(", ") || "message, event, source, timestamp, metadata"}

Expected payload structure:
${
        context?.expectedPayloadShape ? JSON.stringify(context.expectedPayloadShape, null, 2) : `{
  "message": "string content",
  "event": { "type": "string", "reason": "string", "object": {} },
  "source": "string",
  "timestamp": "ISO date string",
  "metadata": { "key": "value" }
}`
      }

JSONLogic operators you can use:
- Logical: "and", "or", "not"
- Comparison: "==", "!=", "<", ">", "<=", ">="
- Data access: "var" (for accessing payload properties)
- Array: "in" (check if value is in array)

Guidelines:
1. Prefer JSONLogic for complex conditions with multiple checks
2. Use "var" to access payload properties (e.g., {"var": "message.length"})
3. Always validate that referenced variables exist in the payload
4. Provide high confidence (0.8+) only when the intent is completely clear
5. Include concrete examples showing how the condition would evaluate
6. Be conservative with confidence - it's better to ask for confirmation

${
        options?.avoidInterpretation
          ? `
IMPORTANT: This is alternative interpretation #${options.alternativeNumber}. 
The primary interpretation was: "${options.avoidInterpretation.explanation}"
Please provide a DIFFERENT interpretation of the same natural language text.
`
          : ""
      }`;

    const userPrompt = `Convert this natural language condition to an executable expression:

"${naturalLanguage}"

Analyze the intent and provide:
1. The most appropriate expression type and content
2. Your confidence level (0.0 to 1.0)
3. Clear explanation of what the condition checks
4. List of variables referenced
5. List of operators used
6. At least 2 concrete examples with expected results`;

    const result = await generateObject({
      model: this.anthropic(this.config.model),
      schema: ConditionParseSchema,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: options?.alternativeNumber ? 0.3 + (options.alternativeNumber * 0.2) : 0.1,
    });

    // Validate the generated expression
    this.validateParsedCondition(result.object, naturalLanguage);

    return result.object;
  }

  /**
   * Validate parsed condition for safety and correctness
   */
  private validateParsedCondition(parsed: ParsedCondition, originalText: string): void {
    // Check confidence bounds
    if (parsed.confidence < 0 || parsed.confidence > 1) {
      throw new Error(`Invalid confidence value: ${parsed.confidence}`);
    }

    // Validate expression content based on type
    switch (parsed.expression.type) {
      case "jsonlogic":
        if (
          typeof parsed.expression.content !== "object" || Array.isArray(parsed.expression.content)
        ) {
          throw new Error("JSONLogic expression must be an object");
        }
        this.validateJSONLogicExpression(parsed.expression.content);
        break;

      case "simple":
        if (typeof parsed.expression.content !== "string") {
          throw new Error("Simple expression must be a string");
        }
        this.validateSimpleExpression(parsed.expression.content as string);
        break;

      case "exact":
        if (typeof parsed.expression.content !== "string") {
          throw new Error("Exact match expression must be a string");
        }
        break;
    }

    // Ensure examples are provided
    if (parsed.examples.length < 2) {
      throw new Error("At least 2 examples are required");
    }

    logger.debug("Parsed condition validation passed", {
      originalText,
      type: parsed.expression.type,
      confidence: parsed.confidence,
      variableCount: parsed.variables.length,
      exampleCount: parsed.examples.length,
    });
  }

  /**
   * Validate JSONLogic expression for safety
   */
  private validateJSONLogicExpression(expression: object): void {
    const allowedOperators = [
      "and",
      "or",
      "not",
      "==",
      "!=",
      "<",
      ">",
      "<=",
      ">=",
      "in",
      "var",
    ];

    const validateNode = (node: unknown): void => {
      if (typeof node !== "object" || node === null) {
        return; // Primitive values are safe
      }

      if (Array.isArray(node)) {
        node.forEach(validateNode);
        return;
      }

      for (const [operator, operands] of Object.entries(node)) {
        if (!allowedOperators.includes(operator)) {
          throw new Error(`Unsafe JSONLogic operator: ${operator}`);
        }

        if (Array.isArray(operands)) {
          operands.forEach(validateNode);
        } else {
          validateNode(operands);
        }
      }
    };

    validateNode(expression);
  }

  /**
   * Validate simple expression for safety (basic check)
   */
  private validateSimpleExpression(expression: string): void {
    // Check for potentially dangerous patterns
    const dangerousPatterns = [
      /eval\s*\(/i,
      /function\s*\(/i,
      /=>\s*{/,
      /import\s+/i,
      /require\s*\(/i,
      /process\./i,
      /global\./i,
      /window\./i,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(expression)) {
        throw new Error(`Potentially unsafe expression pattern detected: ${pattern}`);
      }
    }

    // Ensure only allowed characters
    if (!/^[\w\s\.\&\|\<\>\=\!\(\)\[\]\"\'0-9]+$/.test(expression)) {
      throw new Error("Expression contains disallowed characters");
    }
  }

  /**
   * Confirm a parsing request
   */
  confirmParsing(
    confirmationId: string,
    approved: boolean,
    selectedAlternative?: number,
    userFeedback?: string,
  ): void {
    const request = this.pendingConfirmations.get(confirmationId);
    if (!request) {
      throw new Error(`Confirmation request not found: ${confirmationId}`);
    }

    if (approved) {
      let confirmedParsing = request.parsed;

      if (selectedAlternative !== undefined && request.alternatives[selectedAlternative]) {
        confirmedParsing = request.alternatives[selectedAlternative];
      }

      // Cache the confirmed parsing
      this.confirmedParsings.set(request.originalText, confirmedParsing);

      logger.info("Condition parsing confirmed by user", {
        confirmationId,
        condition: request.originalText,
        selectedAlternative,
        expressionType: confirmedParsing.expression.type,
        userFeedback,
      });
    } else {
      logger.info("Condition parsing rejected by user", {
        confirmationId,
        condition: request.originalText,
        userFeedback,
      });
    }

    // Clean up
    this.pendingConfirmations.delete(confirmationId);
  }

  /**
   * Get pending confirmation requests
   */
  getPendingConfirmations(workspaceId?: string): ConfirmationRequest[] {
    const requests = Array.from(this.pendingConfirmations.values());
    return workspaceId ? requests.filter((req) => req.workspaceId === workspaceId) : requests;
  }

  /**
   * Get confirmation request by ID
   */
  getConfirmationRequest(confirmationId: string): ConfirmationRequest | undefined {
    return this.pendingConfirmations.get(confirmationId);
  }

  /**
   * Clear expired confirmation requests
   */
  cleanupExpiredConfirmations(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, request] of this.pendingConfirmations) {
      if (now - request.timestamp > maxAgeMs) {
        this.pendingConfirmations.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} expired confirmation requests`);
    }

    return cleaned;
  }
}
