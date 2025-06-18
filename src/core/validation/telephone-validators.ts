/**
 * Telephone Game Specific Validators
 *
 * Custom validators and smoke tests specifically designed for the telephone game
 * to validate message transformation quality and coherence.
 */

import { z } from "zod/v4";
import type {
  FunctionalValidator,
  SmokeTest,
  SmokeTestResult,
  StructuralValidator,
  ValidationContext,
  ValidationResult,
} from "./validation-engine.ts";

/**
 * Structural validator for telephone game message format
 */
export const telephoneMessageValidator: StructuralValidator = {
  name: "telephone-message-format",
  schema: z.union([
    z.string().min(1).max(1000),
    z.object({
      message: z.string().min(1).max(1000),
      metadata: z.record(z.string(), z.any()).optional(),
    }),
  ]),
  enabled: true,
};

/**
 * Calculate semantic similarity between two texts (simple implementation)
 */
function calculateSimilarity(text1: string, text2: string): number {
  // Simple word-based similarity calculation
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));

  const intersection = new Set([...words1].filter((x) => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

/**
 * Extract message text from various output formats
 */
function extractMessage(output: any): string {
  if (typeof output === "string") {
    return output;
  }
  if (typeof output === "object" && output.message) {
    return output.message;
  }
  if (typeof output === "object" && output.output) {
    return output.output;
  }
  return JSON.stringify(output);
}

/**
 * Functional validator for telephone message coherence
 */
export const telephoneCoherenceValidator: FunctionalValidator = {
  name: "telephone-coherence",
  pattern: /telephone|mishearing|embellishment|reinterpretation/,
  enabled: true,
  check: async (input: any, output: any, context: ValidationContext): Promise<ValidationResult> => {
    const inputMessage = typeof input === "object" ? input.message : String(input);
    const outputMessage = extractMessage(output);

    if (!inputMessage || !outputMessage) {
      return {
        isValid: false,
        confidence: 0,
        score: 0,
        issues: [{
          type: "completeness" as const,
          severity: "high" as const,
          description: "Missing input or output message",
          suggestion: "Ensure both input and output messages are present",
        }],
        recommendations: ["Check message extraction logic"],
        metadata: {
          validatorUsed: "telephone_coherence",
          duration: 0,
          stage: "functional",
          cached: false,
        },
      };
    }

    const similarity = calculateSimilarity(inputMessage, outputMessage);

    // For telephone game, we want some transformation but not complete divergence
    // Good transformation: 0.2 < similarity < 0.8
    let confidence: number;
    let issues: any[] = [];

    if (similarity < 0.1) {
      confidence = 0.3;
      issues.push({
        type: "quality" as const,
        severity: "medium" as const,
        description: "Output message differs too drastically from input",
        suggestion: "Ensure transformation maintains some connection to original",
      });
    } else if (similarity > 0.9) {
      confidence = 0.4;
      issues.push({
        type: "quality" as const,
        severity: "medium" as const,
        description: "Output message is too similar to input",
        suggestion: "Ensure agent applies meaningful transformation",
      });
    } else {
      confidence = 0.9;
    }

    return {
      isValid: confidence > 0.5,
      confidence,
      score: confidence,
      issues,
      recommendations: [],
      metadata: {
        validatorUsed: "telephone_coherence",
        duration: 0,
        stage: "functional",
        cached: false,
      },
    };
  },
};

/**
 * Functional validator for message length appropriateness
 */
export const telephoneLengthValidator: FunctionalValidator = {
  name: "telephone-length",
  pattern: /telephone|mishearing|embellishment|reinterpretation/,
  enabled: true,
  check: async (input: any, output: any, context: ValidationContext): Promise<ValidationResult> => {
    const inputMessage = typeof input === "object" ? input.message : String(input);
    const outputMessage = extractMessage(output);

    const inputLength = inputMessage.length;
    const outputLength = outputMessage.length;

    // Reasonable length bounds for telephone game
    const ratio = outputLength / inputLength;
    let confidence: number;
    let issues: any[] = [];

    if (ratio < 0.3) {
      confidence = 0.4;
      issues.push({
        type: "quality" as const,
        severity: "low" as const,
        description: "Output message is significantly shorter than input",
        suggestion: "Consider if transformation preserved enough content",
      });
    } else if (ratio > 5.0) {
      confidence = 0.5;
      issues.push({
        type: "quality" as const,
        severity: "low" as const,
        description: "Output message is much longer than input",
        suggestion: "Check if transformation added excessive content",
      });
    } else {
      confidence = 0.8;
    }

    return {
      isValid: confidence > 0.3,
      confidence,
      score: confidence,
      issues,
      recommendations: [],
      metadata: {
        validatorUsed: "telephone_length",
        duration: 0,
        stage: "functional",
        cached: false,
      },
    };
  },
};

/**
 * Smoke test for transformation quality
 */
export const telephoneTransformationTest: SmokeTest = {
  name: "telephone-transformation-quality",
  enabled: true,
  test: async (input: any, output: any, context: ValidationContext): Promise<SmokeTestResult> => {
    const inputMessage = typeof input === "object" ? input.message : String(input);
    const outputMessage = extractMessage(output);

    const similarity = calculateSimilarity(inputMessage, outputMessage);
    const lengthRatio = outputMessage.length / inputMessage.length;

    let confidence = 0.8;
    const flags: string[] = [];
    const issues = [];

    // Check for appropriate transformation
    if (similarity < 0.1) {
      confidence = Math.min(confidence, 0.4);
      flags.push("excessive_transformation");
      issues.push({
        type: "quality" as const,
        severity: "medium" as const,
        description: "Message transformation may be too extreme",
        suggestion: "Review transformation logic",
      });
    }

    if (similarity > 0.95) {
      confidence = Math.min(confidence, 0.3);
      flags.push("insufficient_transformation");
      issues.push({
        type: "quality" as const,
        severity: "medium" as const,
        description: "Message transformation is insufficient",
        suggestion: "Ensure agent applies meaningful changes",
      });
    }

    // Check for reasonable length changes
    if (lengthRatio < 0.2 || lengthRatio > 10) {
      confidence = Math.min(confidence, 0.5);
      flags.push("extreme_length_change");
      issues.push({
        type: "quality" as const,
        severity: "low" as const,
        description: "Extreme length change detected",
        suggestion: "Review length transformation appropriateness",
      });
    }

    // Agent-specific checks based on context
    if (context.agentId.includes("mishearing")) {
      // Mishearing should introduce subtle changes
      if (similarity > 0.8) {
        confidence = Math.min(confidence, 0.4);
        flags.push("mishearing_insufficient");
      }
    } else if (context.agentId.includes("embellishment")) {
      // Embellishment should add content (usually longer)
      if (lengthRatio < 0.8) {
        confidence = Math.min(confidence, 0.6);
        flags.push("embellishment_too_short");
      }
    } else if (context.agentId.includes("reinterpretation")) {
      // Reinterpretation can vary widely
      if (similarity > 0.9) {
        confidence = Math.min(confidence, 0.3);
        flags.push("reinterpretation_insufficient");
      }
    }

    return {
      confidence,
      needsLLMAnalysis: confidence < 0.6,
      flags,
      score: confidence,
      issues,
    };
  },
};

/**
 * Smoke test for message readability and coherence
 */
export const telephoneReadabilityTest: SmokeTest = {
  name: "telephone-readability",
  enabled: true,
  test: async (input: any, output: any, context: ValidationContext): Promise<SmokeTestResult> => {
    const outputMessage = extractMessage(output);

    let confidence = 0.8;
    const flags: string[] = [];
    const issues = [];

    // Check for basic readability issues
    const words = outputMessage.toLowerCase().split(/\s+/);
    const sentences = outputMessage.split(/[.!?]+/).filter((s) => s.trim().length > 0);

    // Check word count
    if (words.length < 3) {
      confidence = Math.min(confidence, 0.4);
      flags.push("too_few_words");
      issues.push({
        type: "quality" as const,
        severity: "medium" as const,
        description: "Output contains very few words",
        suggestion: "Ensure output has sufficient content",
      });
    }

    // Check for reasonable sentence structure
    if (sentences.length === 0 && outputMessage.length > 20) {
      confidence = Math.min(confidence, 0.3);
      flags.push("no_sentence_structure");
      issues.push({
        type: "quality" as const,
        severity: "high" as const,
        description: "Output lacks sentence structure",
        suggestion: "Ensure output forms coherent sentences",
      });
    }

    // Check for excessive repetition
    const wordCounts = new Map<string, number>();
    for (const word of words) {
      if (word.length > 2) { // Skip short words
        wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
      }
    }

    const maxRepetition = Math.max(...Array.from(wordCounts.values()));
    if (maxRepetition > words.length * 0.3) {
      confidence = Math.min(confidence, 0.3);
      flags.push("excessive_word_repetition");
      issues.push({
        type: "quality" as const,
        severity: "medium" as const,
        description: "Excessive word repetition detected",
        suggestion: "Check for agent getting stuck in loops",
      });
    }

    // Check for special characters or formatting issues
    const specialCharRatio = (outputMessage.match(/[^a-zA-Z0-9\s.,!?'"()-]/g) || []).length /
      outputMessage.length;
    if (specialCharRatio > 0.1) {
      confidence = Math.min(confidence, 0.6);
      flags.push("excessive_special_chars");
      issues.push({
        type: "format" as const,
        severity: "low" as const,
        description: "High ratio of special characters",
        suggestion: "Check output formatting",
      });
    }

    return {
      confidence,
      needsLLMAnalysis: confidence < 0.5,
      flags,
      score: confidence,
      issues,
    };
  },
};

/**
 * All telephone game validators and tests
 */
export const telephoneValidators = {
  structural: [telephoneMessageValidator],
  functional: [telephoneCoherenceValidator, telephoneLengthValidator],
  smokeTests: [telephoneTransformationTest, telephoneReadabilityTest],
};

/**
 * Register all telephone validators with a validation engine
 */
export function registerTelephoneValidators(validationEngine: any): void {
  // Register structural validators
  for (const validator of telephoneValidators.structural) {
    validationEngine.registerStructuralValidator("*telephone*", validator);
    validationEngine.registerStructuralValidator("*mishearing*", validator);
    validationEngine.registerStructuralValidator("*embellishment*", validator);
    validationEngine.registerStructuralValidator("*reinterpretation*", validator);
  }

  // Register functional validators
  for (const validator of telephoneValidators.functional) {
    validationEngine.registerFunctionalValidator("*telephone*", validator);
    validationEngine.registerFunctionalValidator("*mishearing*", validator);
    validationEngine.registerFunctionalValidator("*embellishment*", validator);
    validationEngine.registerFunctionalValidator("*reinterpretation*", validator);
  }

  // Register smoke tests
  for (const test of telephoneValidators.smokeTests) {
    validationEngine.registerSmokeTest("*telephone*", test);
    validationEngine.registerSmokeTest("*mishearing*", test);
    validationEngine.registerSmokeTest("*embellishment*", test);
    validationEngine.registerSmokeTest("*reinterpretation*", test);
  }
}
