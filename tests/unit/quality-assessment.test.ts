import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  AgentEvaluation,
  CONFIDENCE_LEVELS,
  CriterionEvaluation,
  DimensionScore,
  QUALITY_ASSESSMENT_SCHEMA,
  QUALITY_THRESHOLDS,
  QualityAssessment,
  QualityIssue,
} from "../../src/core/interfaces/quality-assessment.ts";

// Test data factories
function createValidQualityAssessment(): QualityAssessment {
  return {
    sessionSuccess: true,
    confidence: 85,
    overallReasoning: "All agents executed successfully and met their objectives",
    agentEvaluations: [
      {
        agentId: "agent-1",
        individualSuccess: true,
        completeness: {
          score: 90,
          reasoning: "Agent produced all required outputs",
          issues: [],
          evidence: ["Output contains all expected fields", "No missing data detected"],
        },
        accuracy: {
          score: 85,
          reasoning: "Outputs are factually correct",
          issues: [],
          evidence: ["Data validation passed", "Logic checks successful"],
        },
        format: {
          score: 95,
          reasoning: "Perfect JSON structure",
          issues: [],
          evidence: ["Valid JSON schema", "Proper data types"],
        },
        relevance: {
          score: 88,
          reasoning: "Directly addresses task requirements",
          issues: [],
          evidence: ["Task objectives met", "Output useful for next steps"],
        },
        outputSummary: "Generated valid configuration data with proper validation",
      },
    ],
    successCriteriaEvaluation: [
      {
        criterion: "Execute all agents successfully",
        met: true,
        evidence: "All planned agents completed execution",
        reasoning: "No execution failures detected",
        confidence: 95,
      },
    ],
    qualityIssues: [],
    nextAction: "complete",
    actionReasoning: "All criteria met, session can be marked complete",
    executionSummary: "Session completed successfully with high quality outputs",
  };
}

function createFailedQualityAssessment(): QualityAssessment {
  return {
    sessionSuccess: false,
    confidence: 75,
    overallReasoning: "Critical issues detected in agent outputs requiring retry",
    agentEvaluations: [
      {
        agentId: "agent-1",
        individualSuccess: false,
        completeness: {
          score: 30,
          reasoning: "Missing required output fields",
          issues: ["No 'result' field in output", "Missing error handling"],
          evidence: ["Output schema validation failed"],
        },
        accuracy: {
          score: 0,
          reasoning: "Output contains logical errors",
          issues: ["Contradictory data", "Invalid calculations"],
          evidence: ["Logic validation failed", "Cross-reference check failed"],
        },
        format: {
          score: 60,
          reasoning: "Partial format compliance",
          issues: ["Some fields have wrong types"],
          evidence: ["JSON structure valid but type errors present"],
        },
        relevance: {
          score: 40,
          reasoning: "Output only partially addresses requirements",
          issues: ["Missing key functionality", "Incomplete task completion"],
          evidence: ["Only 2 of 5 requirements addressed"],
        },
        outputSummary: "Incomplete and error-prone configuration with missing components",
      },
    ],
    successCriteriaEvaluation: [
      {
        criterion: "Produce meaningful outputs from each agent",
        met: false,
        evidence: "Agent output contains critical errors and missing data",
        reasoning: "Quality standards not met due to completeness and accuracy issues",
        confidence: 80,
      },
    ],
    qualityIssues: [
      {
        severity: "critical",
        description: "Agent output missing required fields and contains logical errors",
        affectedAgents: ["agent-1"],
        recommendation: "Retry with enhanced validation and error handling",
        impact: "blocking",
      },
    ],
    nextAction: "retry",
    actionReasoning: "Critical issues prevent session completion, retry recommended",
  };
}

// Test suite for Quality Assessment interfaces
Deno.test("Quality Assessment Interfaces", async (t) => {
  await t.step("should validate QualityAssessment structure", () => {
    const assessment = createValidQualityAssessment();

    // Verify required fields exist
    assertExists(assessment.sessionSuccess);
    assertExists(assessment.confidence);
    assertExists(assessment.overallReasoning);
    assertExists(assessment.agentEvaluations);
    assertExists(assessment.successCriteriaEvaluation);
    assertExists(assessment.qualityIssues);
    assertExists(assessment.nextAction);
    assertExists(assessment.actionReasoning);

    // Verify field types
    assertEquals(typeof assessment.sessionSuccess, "boolean");
    assertEquals(typeof assessment.confidence, "number");
    assertEquals(typeof assessment.overallReasoning, "string");
    assertEquals(Array.isArray(assessment.agentEvaluations), true);
    assertEquals(Array.isArray(assessment.successCriteriaEvaluation), true);
    assertEquals(Array.isArray(assessment.qualityIssues), true);
    assertEquals(typeof assessment.nextAction, "string");
    assertEquals(typeof assessment.actionReasoning, "string");
  });

  await t.step("should validate AgentEvaluation structure", () => {
    const assessment = createValidQualityAssessment();
    const agentEval = assessment.agentEvaluations[0];

    // Verify required fields
    assertExists(agentEval.agentId);
    assertExists(agentEval.individualSuccess);
    assertExists(agentEval.completeness);
    assertExists(agentEval.accuracy);
    assertExists(agentEval.format);
    assertExists(agentEval.relevance);

    // Verify DimensionScore structure
    const dimension = agentEval.completeness;
    assertEquals(typeof dimension.score, "number");
    assertEquals(typeof dimension.reasoning, "string");
    assertEquals(Array.isArray(dimension.issues), true);
    assertEquals(Array.isArray(dimension.evidence), true);
  });

  await t.step("should validate CriterionEvaluation structure", () => {
    const assessment = createValidQualityAssessment();
    const criterion = assessment.successCriteriaEvaluation[0];

    assertExists(criterion.criterion);
    assertExists(criterion.met);
    assertExists(criterion.evidence);
    assertExists(criterion.reasoning);
    assertExists(criterion.confidence);

    assertEquals(typeof criterion.criterion, "string");
    assertEquals(typeof criterion.met, "boolean");
    assertEquals(typeof criterion.evidence, "string");
    assertEquals(typeof criterion.reasoning, "string");
    assertEquals(typeof criterion.confidence, "number");
  });

  await t.step("should validate QualityIssue structure", () => {
    const assessment = createFailedQualityAssessment();
    const issue = assessment.qualityIssues[0];

    assertExists(issue.severity);
    assertExists(issue.description);
    assertExists(issue.affectedAgents);
    assertExists(issue.recommendation);
    assertExists(issue.impact);

    assertEquals(typeof issue.severity, "string");
    assertEquals(typeof issue.description, "string");
    assertEquals(Array.isArray(issue.affectedAgents), true);
    assertEquals(typeof issue.recommendation, "string");
    assertEquals(typeof issue.impact, "string");

    // Verify valid severity levels
    assertEquals(["critical", "major", "minor"].includes(issue.severity), true);

    // Verify valid impact levels
    assertEquals(["blocking", "degraded", "cosmetic"].includes(issue.impact!), true);
  });

  await t.step("should validate nextAction values", () => {
    const validActions = ["complete", "retry", "adapt", "escalate"];

    const assessment = createValidQualityAssessment();
    assertEquals(validActions.includes(assessment.nextAction), true);

    const failedAssessment = createFailedQualityAssessment();
    assertEquals(validActions.includes(failedAssessment.nextAction), true);
  });
});

// Test confidence level constants
Deno.test("Confidence Level Constants", async (t) => {
  await t.step("should have properly defined confidence ranges", () => {
    assertEquals(CONFIDENCE_LEVELS.VERY_HIGH.min, 90);
    assertEquals(CONFIDENCE_LEVELS.VERY_HIGH.max, 100);
    assertEquals(CONFIDENCE_LEVELS.HIGH.min, 70);
    assertEquals(CONFIDENCE_LEVELS.HIGH.max, 89);
    assertEquals(CONFIDENCE_LEVELS.MEDIUM.min, 50);
    assertEquals(CONFIDENCE_LEVELS.MEDIUM.max, 69);
    assertEquals(CONFIDENCE_LEVELS.LOW.min, 30);
    assertEquals(CONFIDENCE_LEVELS.LOW.max, 49);
    assertEquals(CONFIDENCE_LEVELS.VERY_LOW.min, 0);
    assertEquals(CONFIDENCE_LEVELS.VERY_LOW.max, 29);
  });

  await t.step("should have non-overlapping confidence ranges", () => {
    const levels = Object.values(CONFIDENCE_LEVELS);

    for (let i = 0; i < levels.length - 1; i++) {
      const currentLevel = levels[i];
      const nextLevel = levels[i + 1];

      // Ensure no gaps or overlaps
      assertEquals(currentLevel.min, nextLevel.max + 1);
    }
  });
});

// Test quality threshold constants
Deno.test("Quality Threshold Constants", async (t) => {
  await t.step("should have properly defined quality ranges", () => {
    assertEquals(QUALITY_THRESHOLDS.EXCELLENT.min, 90);
    assertEquals(QUALITY_THRESHOLDS.EXCELLENT.max, 100);
    assertEquals(QUALITY_THRESHOLDS.GOOD.min, 70);
    assertEquals(QUALITY_THRESHOLDS.GOOD.max, 89);
    assertEquals(QUALITY_THRESHOLDS.ACCEPTABLE.min, 50);
    assertEquals(QUALITY_THRESHOLDS.ACCEPTABLE.max, 69);
    assertEquals(QUALITY_THRESHOLDS.POOR.min, 30);
    assertEquals(QUALITY_THRESHOLDS.POOR.max, 49);
    assertEquals(QUALITY_THRESHOLDS.FAILING.min, 0);
    assertEquals(QUALITY_THRESHOLDS.FAILING.max, 29);
  });
});

// Test schema validation
Deno.test("Quality Assessment Schema", async (t) => {
  await t.step("should define all required fields", () => {
    const expectedRequired = [
      "sessionSuccess",
      "confidence",
      "overallReasoning",
      "agentEvaluations",
      "successCriteriaEvaluation",
      "qualityIssues",
      "nextAction",
      "actionReasoning",
    ];

    assertEquals(QUALITY_ASSESSMENT_SCHEMA.required_fields.length, expectedRequired.length);

    for (const field of expectedRequired) {
      assertEquals(QUALITY_ASSESSMENT_SCHEMA.required_fields.includes(field), true);
    }
  });

  await t.step("should define field types correctly", () => {
    assertEquals(QUALITY_ASSESSMENT_SCHEMA.field_types.sessionSuccess, "boolean");
    assertEquals(QUALITY_ASSESSMENT_SCHEMA.field_types.confidence, "number");
    assertEquals(QUALITY_ASSESSMENT_SCHEMA.field_types.overallReasoning, "string");
    assertEquals(QUALITY_ASSESSMENT_SCHEMA.field_types.agentEvaluations, "array");
    assertEquals(QUALITY_ASSESSMENT_SCHEMA.field_types.successCriteriaEvaluation, "array");
    assertEquals(QUALITY_ASSESSMENT_SCHEMA.field_types.qualityIssues, "array");
    assertEquals(QUALITY_ASSESSMENT_SCHEMA.field_types.nextAction, "string");
    assertEquals(QUALITY_ASSESSMENT_SCHEMA.field_types.actionReasoning, "string");
  });

  await t.step("should validate confidence range", () => {
    const validateConfidence = QUALITY_ASSESSMENT_SCHEMA.validation_rules.confidence;

    assertEquals(validateConfidence(0), true);
    assertEquals(validateConfidence(50), true);
    assertEquals(validateConfidence(100), true);
    assertEquals(validateConfidence(-1), false);
    assertEquals(validateConfidence(101), false);
  });

  await t.step("should validate nextAction values", () => {
    const validateNextAction = QUALITY_ASSESSMENT_SCHEMA.validation_rules.nextAction;

    assertEquals(validateNextAction("complete"), true);
    assertEquals(validateNextAction("retry"), true);
    assertEquals(validateNextAction("adapt"), true);
    assertEquals(validateNextAction("escalate"), true);
    assertEquals(validateNextAction("invalid"), false);
  });

  await t.step("should validate agentEvaluations array", () => {
    const validateAgentEvaluations = QUALITY_ASSESSMENT_SCHEMA.validation_rules.agentEvaluations;

    assertEquals(validateAgentEvaluations([{ agentId: "test" }]), true);
    assertEquals(validateAgentEvaluations([]), false);
    assertEquals(validateAgentEvaluations("not-array"), false);
  });
});

// Test real-world scenarios
Deno.test("Quality Assessment Real-World Scenarios", async (t) => {
  await t.step("should handle successful session assessment", () => {
    const assessment = createValidQualityAssessment();

    assertEquals(assessment.sessionSuccess, true);
    assertEquals(assessment.nextAction, "complete");
    assertEquals(assessment.qualityIssues.length, 0);
    assertEquals(assessment.agentEvaluations[0].individualSuccess, true);
    assertEquals(assessment.confidence >= CONFIDENCE_LEVELS.HIGH.min, true);
  });

  await t.step("should handle failed session assessment", () => {
    const assessment = createFailedQualityAssessment();

    assertEquals(assessment.sessionSuccess, false);
    assertEquals(assessment.nextAction, "retry");
    assertEquals(assessment.qualityIssues.length > 0, true);
    assertEquals(assessment.agentEvaluations[0].individualSuccess, false);

    // Verify critical issue exists
    const criticalIssues = assessment.qualityIssues.filter((issue) =>
      issue.severity === "critical"
    );
    assertEquals(criticalIssues.length > 0, true);
  });

  await t.step("should provide actionable feedback", () => {
    const assessment = createFailedQualityAssessment();

    // Verify reasoning is provided
    assertEquals(assessment.overallReasoning.length > 0, true);
    assertEquals(assessment.actionReasoning.length > 0, true);

    // Verify quality issues have recommendations
    for (const issue of assessment.qualityIssues) {
      assertEquals(issue.recommendation.length > 0, true);
      assertEquals(issue.description.length > 0, true);
    }

    // Verify agent evaluations have reasoning
    for (const agentEval of assessment.agentEvaluations) {
      assertEquals(agentEval.completeness.reasoning.length > 0, true);
      assertEquals(agentEval.accuracy.reasoning.length > 0, true);
      assertEquals(agentEval.format.reasoning.length > 0, true);
      assertEquals(agentEval.relevance.reasoning.length > 0, true);
    }
  });
});
