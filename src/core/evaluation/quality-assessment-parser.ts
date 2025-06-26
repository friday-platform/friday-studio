/**
 * Quality Assessment Parser and Validator
 *
 * Handles parsing and validation of structured LLM responses for quality assessment
 * with comprehensive error handling and fallback mechanisms.
 */

import {
  AssessmentMetrics,
  AssessmentValidationResult,
  CONFIDENCE_LEVELS,
  QUALITY_ASSESSMENT_SCHEMA,
  QualityAssessment,
} from "../interfaces/quality-assessment.ts";
import { logger } from "../../utils/logger.ts";

export class QualityAssessmentParser {
  /**
   * Parse and validate LLM response into structured QualityAssessment
   */
  static async parseQualityAssessment(
    llmResponse: string,
    expectedAgentIds: string[],
    sessionId: string,
  ): Promise<AssessmentValidationResult> {
    const startTime = Date.now();

    try {
      // Security check: Limit response size to prevent memory attacks
      if (llmResponse.length > 5 * 1024 * 1024) { // 5MB limit
        logger.error("LLM response too large - potential DoS attack", {
          sessionId,
          responseSize: llmResponse.length,
          maxAllowed: 5 * 1024 * 1024,
        });
        return {
          isValid: false,
          errors: [
            `Response too large: ${
              Math.round(llmResponse.length / 1024 / 1024)
            }MB exceeds 5MB limit`,
          ],
          warnings: ["Large response rejected for security"],
        };
      }
      // Step 1: Extract JSON from LLM response
      const jsonExtraction = this.extractJsonFromResponse(llmResponse);
      if (!jsonExtraction.success) {
        return {
          isValid: false,
          errors: [`JSON extraction failed: ${jsonExtraction.error}`],
          warnings: [],
        };
      }

      // Step 2: Parse JSON safely
      let rawAssessment: unknown;
      try {
        rawAssessment = JSON.parse(jsonExtraction.json);
      } catch (parseError) {
        logger.error("Malformed JSON in LLM response", {
          sessionId,
          parseError: parseError.message,
          responseLength: llmResponse.length,
          jsonLength: jsonExtraction.json.length,
        });
        return {
          isValid: false,
          errors: [`SECURITY: Malformed JSON rejected - ${parseError.message}`],
          warnings: ["Potential malicious response detected"],
        };
      }

      // Step 3: Validate structure and content
      const validation = this.validateAssessmentStructure(
        rawAssessment,
        expectedAgentIds,
        sessionId,
      );

      // Step 4: Log validation metrics
      const duration = Date.now() - startTime;
      this.logParsingMetrics(sessionId, validation, duration);

      return validation;
    } catch (error) {
      logger.error("Quality assessment parsing failed", {
        sessionId,
        error: error.message,
        llmResponseLength: llmResponse.length,
      });

      return {
        isValid: false,
        errors: [`Unexpected parsing error: ${error.message}`],
        warnings: [],
      };
    }
  }

  /**
   * Extract JSON block from LLM response
   */
  private static extractJsonFromResponse(response: string): {
    success: boolean;
    json?: string;
    error?: string;
  } {
    // Look for JSON code block
    const jsonBlockMatch = response.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonBlockMatch) {
      return { success: true, json: jsonBlockMatch[1].trim() };
    }

    // Look for JSON object without code block markers
    const jsonObjectMatch = response.match(/(\{[\s\S]*\})/);
    if (jsonObjectMatch) {
      // Validate it looks like valid JSON
      const candidateJson = jsonObjectMatch[1].trim();
      if (candidateJson.startsWith("{") && candidateJson.endsWith("}")) {
        return { success: true, json: candidateJson };
      }
    }

    // Look for JSON array (fallback)
    const jsonArrayMatch = response.match(/(\[[\s\S]*\])/);
    if (jsonArrayMatch) {
      return {
        success: false,
        error: "Found JSON array instead of object. Expected object structure.",
      };
    }

    return {
      success: false,
      error: "No valid JSON structure found in response",
    };
  }

  /**
   * Validate the structure and content of the assessment
   */
  private static validateAssessmentStructure(
    assessment: unknown,
    expectedAgentIds: string[],
    _sessionId: string,
  ): AssessmentValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Step 1: Validate required fields exist
      const missingRequired = this.validateRequiredFields(assessment);
      errors.push(...missingRequired);

      // Step 2: Validate field types
      const typeErrors = this.validateFieldTypes(assessment);
      errors.push(...typeErrors);

      // Step 3: Validate field values and ranges
      const valueErrors = this.validateFieldValues(assessment);
      errors.push(...valueErrors);

      // Step 4: Validate agent coverage
      const agentCoverageIssues = this.validateAgentCoverage(assessment, expectedAgentIds);
      errors.push(...agentCoverageIssues.errors);
      warnings.push(...agentCoverageIssues.warnings);

      // Step 5: Validate assessment consistency
      const consistencyIssues = this.validateAssessmentConsistency(assessment);
      warnings.push(...consistencyIssues);

      // Step 6: Validate evidence quality
      const evidenceIssues = this.validateEvidenceQuality(assessment);
      warnings.push(...evidenceIssues);

      // Return validation result
      const isValid = errors.length === 0;
      const result: AssessmentValidationResult = {
        isValid,
        errors,
        warnings,
      };

      if (isValid) {
        result.parsedAssessment = assessment as QualityAssessment;
      }

      return result;
    } catch (error) {
      return {
        isValid: false,
        errors: [`Validation process failed: ${error.message}`],
        warnings,
      };
    }
  }

  /**
   * Validate that all required fields are present
   */
  private static validateRequiredFields(assessment: unknown): string[] {
    const errors: string[] = [];
    const assessmentObj = assessment as Record<string, unknown>;

    for (const field of QUALITY_ASSESSMENT_SCHEMA.required_fields) {
      if (!(field in assessmentObj)) {
        errors.push(`Missing required field: ${field}`);
      } else if (assessmentObj[field] === null || assessmentObj[field] === undefined) {
        errors.push(`Required field is null/undefined: ${field}`);
      }
    }

    return errors;
  }

  /**
   * Validate field types match expected types
   */
  private static validateFieldTypes(assessment: unknown): string[] {
    const errors: string[] = [];
    const assessmentObj = assessment as Record<string, unknown>;

    for (const [field, expectedType] of Object.entries(QUALITY_ASSESSMENT_SCHEMA.field_types)) {
      if (!(field in assessmentObj)) continue; // Skip missing fields (handled elsewhere)

      const actualValue = assessmentObj[field];
      const actualType = Array.isArray(actualValue) ? "array" : typeof actualValue;

      if (actualType !== expectedType) {
        errors.push(`Field '${field}' has type '${actualType}', expected '${expectedType}'`);
      }
    }

    return errors;
  }

  /**
   * Validate field values are within acceptable ranges and formats
   */
  private static validateFieldValues(assessment: unknown): string[] {
    const errors: string[] = [];
    const assessmentObj = assessment as Record<string, unknown>;

    // Validate confidence range
    if ("confidence" in assessmentObj) {
      const validation = QUALITY_ASSESSMENT_SCHEMA.validation_rules.confidence;
      if (!validation(assessmentObj.confidence)) {
        errors.push(`Confidence score ${assessmentObj.confidence} is outside valid range 0-100`);
      }
    }

    // Validate nextAction
    if ("nextAction" in assessmentObj) {
      const validation = QUALITY_ASSESSMENT_SCHEMA.validation_rules.nextAction;
      if (!validation(assessmentObj.nextAction)) {
        errors.push(
          `nextAction '${assessmentObj.nextAction}' is not valid. Must be one of: complete, retry, adapt, escalate`,
        );
      }
    }

    // Validate agentEvaluations
    if ("agentEvaluations" in assessmentObj) {
      const validation = QUALITY_ASSESSMENT_SCHEMA.validation_rules.agentEvaluations;
      if (!validation(assessmentObj.agentEvaluations as unknown[])) {
        errors.push("agentEvaluations must be a non-empty array");
      }

      // Validate individual agent evaluations
      if (Array.isArray(assessmentObj.agentEvaluations)) {
        const agentEvaluations = assessmentObj.agentEvaluations as unknown[];
        for (let i = 0; i < agentEvaluations.length; i++) {
          const agentEval = agentEvaluations[i];
          const agentErrors = this.validateAgentEvaluation(agentEval, i);
          errors.push(...agentErrors);
        }
      }
    }

    // Validate quality issues
    if ("qualityIssues" in assessmentObj && Array.isArray(assessmentObj.qualityIssues)) {
      const qualityIssues = assessmentObj.qualityIssues as unknown[];
      for (let i = 0; i < qualityIssues.length; i++) {
        const issue = qualityIssues[i];
        const issueErrors = this.validateQualityIssue(issue, i);
        errors.push(...issueErrors);
      }
    }

    return errors;
  }

  /**
   * Validate individual agent evaluation structure
   */
  private static validateAgentEvaluation(agentEval: unknown, index: number): string[] {
    const errors: string[] = [];
    const prefix = `agentEvaluations[${index}]`;
    const agentEvalObj = agentEval as Record<string, unknown>;

    // Required fields for agent evaluation
    const requiredFields = [
      "agentId",
      "individualSuccess",
      "completeness",
      "accuracy",
      "format",
      "relevance",
    ];
    for (const field of requiredFields) {
      if (!(field in agentEvalObj)) {
        errors.push(`${prefix}: Missing required field '${field}'`);
      }
    }

    // Validate dimension scores
    const dimensions = ["completeness", "accuracy", "format", "relevance"];
    for (const dimension of dimensions) {
      if (dimension in agentEvalObj) {
        const dimErrors = this.validateDimensionScore(
          agentEvalObj[dimension],
          `${prefix}.${dimension}`,
        );
        errors.push(...dimErrors);
      }
    }

    return errors;
  }

  /**
   * Validate dimension score structure
   */
  private static validateDimensionScore(dimension: unknown, prefix: string): string[] {
    const errors: string[] = [];
    const dimensionObj = dimension as Record<string, unknown>;

    const requiredFields = ["score", "reasoning", "issues"];
    for (const field of requiredFields) {
      if (!(field in dimensionObj)) {
        errors.push(`${prefix}: Missing required field '${field}'`);
      }
    }

    // Validate score range
    if ("score" in dimensionObj) {
      if (
        typeof dimensionObj.score !== "number" || dimensionObj.score < 0 || dimensionObj.score > 100
      ) {
        errors.push(`${prefix}.score: Must be a number between 0-100, got ${dimensionObj.score}`);
      }
    }

    // Validate reasoning is non-empty
    if ("reasoning" in dimensionObj) {
      if (
        typeof dimensionObj.reasoning !== "string" ||
        (dimensionObj.reasoning as string).trim().length === 0
      ) {
        errors.push(`${prefix}.reasoning: Must be a non-empty string`);
      }
    }

    // Validate issues is an array
    if ("issues" in dimensionObj) {
      if (!Array.isArray(dimensionObj.issues)) {
        errors.push(`${prefix}.issues: Must be an array`);
      }
    }

    return errors;
  }

  /**
   * Validate quality issue structure
   */
  private static validateQualityIssue(issue: unknown, index: number): string[] {
    const errors: string[] = [];
    const prefix = `qualityIssues[${index}]`;
    const issueObj = issue as Record<string, unknown>;

    const requiredFields = ["severity", "description", "affectedAgents", "recommendation"];
    for (const field of requiredFields) {
      if (!(field in issueObj)) {
        errors.push(`${prefix}: Missing required field '${field}'`);
      }
    }

    // Validate severity
    if ("severity" in issueObj) {
      const validSeverities = ["critical", "major", "minor"];
      if (!validSeverities.includes(issueObj.severity as string)) {
        errors.push(
          `${prefix}.severity: Must be one of ${
            validSeverities.join(", ")
          }, got '${issueObj.severity}'`,
        );
      }
    }

    // Validate impact (optional field)
    if ("impact" in issueObj) {
      const validImpacts = ["blocking", "degraded", "cosmetic"];
      if (!validImpacts.includes(issueObj.impact as string)) {
        errors.push(
          `${prefix}.impact: Must be one of ${validImpacts.join(", ")}, got '${issueObj.impact}'`,
        );
      }
    }

    // Validate affectedAgents is array
    if ("affectedAgents" in issueObj && !Array.isArray(issueObj.affectedAgents)) {
      errors.push(`${prefix}.affectedAgents: Must be an array`);
    }

    return errors;
  }

  /**
   * Validate that assessment covers all expected agents
   */
  private static validateAgentCoverage(
    assessment: unknown,
    expectedAgentIds: string[],
  ): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    const assessmentObj = assessment as Record<string, unknown>;
    if (!("agentEvaluations" in assessmentObj) || !Array.isArray(assessmentObj.agentEvaluations)) {
      return { errors, warnings };
    }

    const evaluatedAgentIds = new Set(
      assessmentObj.agentEvaluations.map((agentEval: unknown) =>
        (agentEval as Record<string, unknown>).agentId
      ).filter(Boolean),
    );
    const expectedAgentSet = new Set(expectedAgentIds);

    // Check for missing agent evaluations
    for (const expectedId of expectedAgentIds) {
      if (!evaluatedAgentIds.has(expectedId)) {
        errors.push(`Missing evaluation for expected agent: ${expectedId}`);
      }
    }

    // Check for unexpected agent evaluations
    for (const evaluatedId of evaluatedAgentIds) {
      if (!expectedAgentSet.has(evaluatedId as string)) {
        warnings.push(`Evaluation provided for unexpected agent: ${evaluatedId}`);
      }
    }

    return { errors, warnings };
  }

  /**
   * Validate internal consistency of the assessment
   */
  private static validateAssessmentConsistency(assessment: unknown): string[] {
    const warnings: string[] = [];
    const assessmentObj = assessment as Record<string, unknown>;

    try {
      // Check consistency between sessionSuccess and agent individual success
      if ("sessionSuccess" in assessmentObj && "agentEvaluations" in assessmentObj) {
        const agentEvaluations = assessmentObj.agentEvaluations as unknown[];
        const allAgentsSuccessful = agentEvaluations.every(
          (agentEval: unknown) => (agentEval as Record<string, unknown>).individualSuccess === true,
        );

        if (assessmentObj.sessionSuccess && !allAgentsSuccessful) {
          warnings.push("Session marked successful but not all agents individually successful");
        }
      }

      // Check consistency between sessionSuccess and qualityIssues
      if ("sessionSuccess" in assessmentObj && "qualityIssues" in assessmentObj) {
        const qualityIssues = assessmentObj.qualityIssues as unknown[];
        const hasCriticalIssues = qualityIssues.some(
          (issue: unknown) => (issue as Record<string, unknown>).severity === "critical",
        );

        if (assessmentObj.sessionSuccess && hasCriticalIssues) {
          warnings.push("Session marked successful but critical quality issues identified");
        }
      }

      // Check consistency between nextAction and sessionSuccess
      if ("sessionSuccess" in assessmentObj && "nextAction" in assessmentObj) {
        if (assessmentObj.sessionSuccess && assessmentObj.nextAction !== "complete") {
          warnings.push(
            `Session successful but nextAction is '${assessmentObj.nextAction}' instead of 'complete'`,
          );
        }

        if (!assessmentObj.sessionSuccess && assessmentObj.nextAction === "complete") {
          warnings.push("Session not successful but nextAction is 'complete'");
        }
      }

      // Check confidence vs. uncertainty indicators
      if ("confidence" in assessmentObj) {
        const hasUncertaintyLanguage = [
          "overallReasoning",
          "actionReasoning",
        ].some((field) => {
          if (field in assessmentObj && typeof assessmentObj[field] === "string") {
            const text = (assessmentObj[field] as string).toLowerCase();
            return text.includes("uncertain") ||
              text.includes("unclear") ||
              text.includes("ambiguous") ||
              text.includes("not sure");
          }
          return false;
        });

        const confidence = assessmentObj.confidence as number;
        if (confidence > 80 && hasUncertaintyLanguage) {
          warnings.push("High confidence but uncertainty language detected in reasoning");
        }
      }
    } catch (error) {
      warnings.push(`Consistency validation error: ${error.message}`);
    }

    return warnings;
  }

  /**
   * Validate evidence quality in the assessment
   */
  private static validateEvidenceQuality(assessment: unknown): string[] {
    const warnings: string[] = [];
    const assessmentObj = assessment as Record<string, unknown>;

    try {
      // Check for empty or generic reasoning
      if ("agentEvaluations" in assessmentObj && Array.isArray(assessmentObj.agentEvaluations)) {
        const agentEvaluations = assessmentObj.agentEvaluations as unknown[];
        for (let i = 0; i < agentEvaluations.length; i++) {
          const agentEval = agentEvaluations[i] as Record<string, unknown>;
          const dimensions = ["completeness", "accuracy", "format", "relevance"];

          for (const dimension of dimensions) {
            if (dimension in agentEval) {
              const dimensionObj = agentEval[dimension] as Record<string, unknown>;
              if ("reasoning" in dimensionObj) {
                const reasoning = dimensionObj.reasoning as string;
                if (typeof reasoning === "string" && reasoning.trim().length < 10) {
                  warnings.push(`Agent ${agentEval.agentId} ${dimension} reasoning is very brief`);
                }

                // Check for generic phrases
                const genericPhrases = ["looks good", "seems fine", "appears correct", "no issues"];
                if (genericPhrases.some((phrase) => reasoning.toLowerCase().includes(phrase))) {
                  warnings.push(
                    `Agent ${agentEval.agentId} ${dimension} reasoning uses generic language`,
                  );
                }
              }
            }
          }
        }
      }

      // Check for missing evidence arrays
      if ("agentEvaluations" in assessmentObj && Array.isArray(assessmentObj.agentEvaluations)) {
        const agentEvaluations = assessmentObj.agentEvaluations as unknown[];
        for (const agentEval of agentEvaluations) {
          const agentEvalObj = agentEval as Record<string, unknown>;
          const dimensions = ["completeness", "accuracy", "format", "relevance"];
          for (const dimension of dimensions) {
            if (dimension in agentEvalObj) {
              const dim = agentEvalObj[dimension] as Record<string, unknown>;
              if (
                !("evidence" in dim) || !Array.isArray(dim.evidence) ||
                (dim.evidence as unknown[]).length === 0
              ) {
                warnings.push(`Agent ${agentEvalObj.agentId} ${dimension} lacks specific evidence`);
              }
            }
          }
        }
      }
    } catch (error) {
      warnings.push(`Evidence quality validation error: ${error.message}`);
    }

    return warnings;
  }

  /**
   * Log parsing metrics for monitoring and improvement
   */
  private static logParsingMetrics(
    sessionId: string,
    validation: AssessmentValidationResult,
    duration: number,
  ): Promise<void> {
    const metrics: Partial<AssessmentMetrics> = {
      sessionId,
      evaluationMethod: "structured_llm",
      evaluationDuration: duration,
      timestamp: new Date().toISOString(),
    };

    if (validation.parsedAssessment) {
      metrics.assessmentConfidence = validation.parsedAssessment.confidence;
      metrics.agentsEvaluated = validation.parsedAssessment.agentEvaluations.length;
      metrics.criticalIssues = validation.parsedAssessment.qualityIssues.filter(
        (issue) => issue.severity === "critical",
      ).length;
      metrics.majorIssues = validation.parsedAssessment.qualityIssues.filter(
        (issue) => issue.severity === "major",
      ).length;
      metrics.minorIssues = validation.parsedAssessment.qualityIssues.filter(
        (issue) => issue.severity === "minor",
      ).length;
      metrics.overallSuccess = validation.parsedAssessment.sessionSuccess;
    }

    logger.debug("Quality assessment parsing metrics", {
      ...metrics,
      validationErrors: validation.errors.length,
      validationWarnings: validation.warnings.length,
      isValid: validation.isValid,
    });
    
    return Promise.resolve();
  }

  /**
   * Create a confidence-based decision from validated assessment
   */
  static makeCompletionDecision(assessment: QualityAssessment): {
    isComplete: boolean;
    nextAction?: "continue" | "retry" | "adapt" | "escalate";
    feedback?: string;
  } {
    // High confidence decisions
    if (assessment.confidence >= CONFIDENCE_LEVELS.HIGH.min) {
      return {
        isComplete: assessment.sessionSuccess,
        nextAction: assessment.nextAction === "complete" ? "continue" : assessment.nextAction,
        feedback: this.formatAssessmentFeedback(assessment),
      };
    }

    // Medium confidence - be conservative
    if (assessment.confidence >= CONFIDENCE_LEVELS.MEDIUM.min) {
      const criticalIssues = assessment.qualityIssues.filter((i) => i.severity === "critical");
      return {
        isComplete: assessment.sessionSuccess && criticalIssues.length === 0,
        nextAction: criticalIssues.length > 0 ? "retry" : (assessment.nextAction === "complete" ? "continue" : assessment.nextAction),
        feedback: this.formatAssessmentFeedback(assessment),
      };
    }

    // Low confidence - escalate to human
    return {
      isComplete: false,
      nextAction: "escalate",
      feedback:
        `Low confidence assessment (${assessment.confidence}%). Human review required: ${assessment.overallReasoning}`,
    };
  }

  /**
   * Format assessment feedback for human readability
   */
  private static formatAssessmentFeedback(assessment: QualityAssessment): string {
    const parts: string[] = [];

    // Overall assessment
    parts.push(`Assessment (${assessment.confidence}% confidence): ${assessment.overallReasoning}`);

    // Quality issues summary
    if (assessment.qualityIssues.length > 0) {
      const criticalCount = assessment.qualityIssues.filter((i) =>
        i.severity === "critical"
      ).length;
      const majorCount = assessment.qualityIssues.filter((i) => i.severity === "major").length;
      const minorCount = assessment.qualityIssues.filter((i) => i.severity === "minor").length;

      const issueSummary = [];
      if (criticalCount > 0) issueSummary.push(`${criticalCount} critical`);
      if (majorCount > 0) issueSummary.push(`${majorCount} major`);
      if (minorCount > 0) issueSummary.push(`${minorCount} minor`);

      parts.push(`Quality Issues: ${issueSummary.join(", ")}`);
    }

    // Next action reasoning
    if (assessment.actionReasoning) {
      parts.push(`Next Action: ${assessment.actionReasoning}`);
    }

    return parts.join("\n");
  }
}
