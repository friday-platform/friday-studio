import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { QualityAssessmentParser } from "../../src/core/evaluation/quality-assessment-parser.ts";
import { QualityAssessment } from "../../src/core/interfaces/quality-assessment.ts";

// Test data factories
function createValidLLMResponse(): string {
  return `Based on my analysis, here is the quality assessment:

\`\`\`json
{
  "sessionSuccess": true,
  "confidence": 85,
  "overallReasoning": "All agents executed successfully with high-quality outputs",
  "agentEvaluations": [
    {
      "agentId": "agent-1",
      "individualSuccess": true,
      "completeness": {
        "score": 90,
        "reasoning": "Agent produced all required outputs",
        "issues": [],
        "evidence": ["Output contains all expected fields"]
      },
      "accuracy": {
        "score": 85,
        "reasoning": "Outputs are factually correct",
        "issues": [],
        "evidence": ["Data validation passed"]
      },
      "format": {
        "score": 95,
        "reasoning": "Perfect JSON structure",
        "issues": [],
        "evidence": ["Valid JSON schema"]
      },
      "relevance": {
        "score": 88,
        "reasoning": "Directly addresses task requirements",
        "issues": [],
        "evidence": ["Task objectives met"]
      },
      "outputSummary": "Generated valid configuration data"
    }
  ],
  "successCriteriaEvaluation": [
    {
      "criterion": "Execute all agents successfully",
      "met": true,
      "evidence": "All planned agents completed execution",
      "reasoning": "No execution failures detected",
      "confidence": 95
    }
  ],
  "qualityIssues": [],
  "nextAction": "complete",
  "actionReasoning": "All criteria met, session can be marked complete"
}
\`\`\`

This assessment shows successful completion.`;
}

function createInvalidJsonResponse(): string {
  return `Here's my assessment:

\`\`\`json
{
  "sessionSuccess": true,
  "confidence": 85,
  "agentEvaluations": [
    {
      "agentId": "agent-1",
      "individualSuccess": true,
      // Missing required fields
    }
  ]
  // Missing closing brace and other required fields
\`\`\``;
}

function createMissingFieldsResponse(): string {
  return `\`\`\`json
{
  "sessionSuccess": true,
  "confidence": 85
}
\`\`\``;
}

function createInvalidConfidenceResponse(): string {
  return `\`\`\`json
{
  "sessionSuccess": true,
  "confidence": 150,
  "overallReasoning": "Test reasoning",
  "agentEvaluations": [],
  "successCriteriaEvaluation": [],
  "qualityIssues": [],
  "nextAction": "complete",
  "actionReasoning": "Test action reasoning"
}
\`\`\``;
}

function createInconsistentResponse(): string {
  return `\`\`\`json
{
  "sessionSuccess": true,
  "confidence": 90,
  "overallReasoning": "Session successful despite issues",
  "agentEvaluations": [
    {
      "agentId": "agent-1",
      "individualSuccess": false,
      "completeness": {
        "score": 30,
        "reasoning": "Missing required outputs",
        "issues": ["No result field"],
        "evidence": ["Output validation failed"]
      },
      "accuracy": {
        "score": 0,
        "reasoning": "Contains errors",
        "issues": ["Logical errors"],
        "evidence": ["Logic validation failed"]
      },
      "format": {
        "score": 50,
        "reasoning": "Partial compliance",
        "issues": ["Type errors"],
        "evidence": ["Some errors present"]
      },
      "relevance": {
        "score": 40,
        "reasoning": "Partial relevance",
        "issues": ["Missing functionality"],
        "evidence": ["Only 2 of 5 requirements met"]
      },
      "outputSummary": "Failed output"
    }
  ],
  "successCriteriaEvaluation": [
    {
      "criterion": "Produce meaningful outputs",
      "met": false,
      "evidence": "Output contains errors",
      "reasoning": "Quality not met",
      "confidence": 80
    }
  ],
  "qualityIssues": [
    {
      "severity": "critical",
      "description": "Agent output failed",
      "affectedAgents": ["agent-1"],
      "recommendation": "Retry execution",
      "impact": "blocking"
    }
  ],
  "nextAction": "complete",
  "actionReasoning": "Completing despite failures"
}
\`\`\``;
}

// Test suite for Quality Assessment Parser
Deno.test("Quality Assessment Parser", async (t) => {
  await t.step("should parse valid LLM response successfully", async () => {
    const response = createValidLLMResponse();
    const expectedAgents = ["agent-1"];

    const result = await QualityAssessmentParser.parseQualityAssessment(
      response,
      expectedAgents,
      "test-session",
    );

    assertEquals(result.isValid, true);
    assertEquals(result.errors.length, 0);
    assertExists(result.parsedAssessment);
    assertEquals(result.parsedAssessment!.sessionSuccess, true);
    assertEquals(result.parsedAssessment!.confidence, 85);
    assertEquals(result.parsedAssessment!.agentEvaluations.length, 1);
    assertEquals(result.parsedAssessment!.agentEvaluations[0].agentId, "agent-1");
  });

  await t.step("should detect invalid JSON structure", async () => {
    const response = createInvalidJsonResponse();
    const expectedAgents = ["agent-1"];

    const result = await QualityAssessmentParser.parseQualityAssessment(
      response,
      expectedAgents,
      "test-session",
    );

    assertEquals(result.isValid, false);
    assertEquals(result.errors.length > 0, true);
    assertEquals(result.errors[0].includes("JSON parsing failed"), true);
  });

  await t.step("should detect missing required fields", async () => {
    const response = createMissingFieldsResponse();
    const expectedAgents = ["agent-1"];

    const result = await QualityAssessmentParser.parseQualityAssessment(
      response,
      expectedAgents,
      "test-session",
    );

    assertEquals(result.isValid, false);
    assertEquals(result.errors.length > 0, true);

    // Should detect multiple missing fields
    const missingFields = result.errors.filter((err) => err.includes("Missing required field"));
    assertEquals(missingFields.length > 0, true);
  });

  await t.step("should detect invalid confidence values", async () => {
    const response = createInvalidConfidenceResponse();
    const expectedAgents = [];

    const result = await QualityAssessmentParser.parseQualityAssessment(
      response,
      expectedAgents,
      "test-session",
    );

    assertEquals(result.isValid, false);

    const confidenceError = result.errors.find((err) =>
      err.includes("Confidence score") && err.includes("outside valid range")
    );
    assertExists(confidenceError);
  });

  await t.step("should detect assessment inconsistencies", async () => {
    const response = createInconsistentResponse();
    const expectedAgents = ["agent-1"];

    const result = await QualityAssessmentParser.parseQualityAssessment(
      response,
      expectedAgents,
      "test-session",
    );

    // Should parse but have warnings about inconsistencies
    assertEquals(result.isValid, true); // Structure is valid
    assertEquals(result.warnings.length > 0, true);

    // Should detect inconsistency between sessionSuccess and agent failure
    const inconsistencyWarning = result.warnings.find((warning) =>
      warning.includes("successful but not all agents individually successful")
    );
    assertExists(inconsistencyWarning);
  });

  await t.step("should detect missing agent coverage", async () => {
    const response = createValidLLMResponse();
    const expectedAgents = ["agent-1", "agent-2", "agent-3"]; // More agents than evaluated

    const result = await QualityAssessmentParser.parseQualityAssessment(
      response,
      expectedAgents,
      "test-session",
    );

    assertEquals(result.isValid, false);

    // Should detect missing agent evaluations
    const missingAgentErrors = result.errors.filter((err) =>
      err.includes("Missing evaluation for expected agent")
    );
    assertEquals(missingAgentErrors.length, 2); // agent-2 and agent-3 missing
  });

  await t.step("should handle response without JSON blocks", async () => {
    const response = "There was an issue with the evaluation. No structured data available.";
    const expectedAgents = ["agent-1"];

    const result = await QualityAssessmentParser.parseQualityAssessment(
      response,
      expectedAgents,
      "test-session",
    );

    assertEquals(result.isValid, false);
    assertEquals(result.errors.length > 0, true);
    assertEquals(result.errors[0].includes("No valid JSON structure found"), true);
  });

  await t.step("should validate dimension score structures", async () => {
    const responseWithInvalidDimensions = `\`\`\`json
{
  "sessionSuccess": true,
  "confidence": 85,
  "overallReasoning": "Test",
  "agentEvaluations": [
    {
      "agentId": "agent-1",
      "individualSuccess": true,
      "completeness": {
        "score": 150,
        "reasoning": "",
        "issues": "not-an-array"
      },
      "accuracy": {
        "score": "not-a-number",
        "reasoning": "Test",
        "issues": []
      },
      "format": {
        "reasoning": "Missing score",
        "issues": []
      },
      "relevance": {
        "score": 85,
        "reasoning": "Test",
        "issues": []
      }
    }
  ],
  "successCriteriaEvaluation": [],
  "qualityIssues": [],
  "nextAction": "complete",
  "actionReasoning": "Test"
}
\`\`\``;

    const result = await QualityAssessmentParser.parseQualityAssessment(
      responseWithInvalidDimensions,
      ["agent-1"],
      "test-session",
    );

    assertEquals(result.isValid, false);

    // Should detect multiple dimension validation errors
    const dimensionErrors = result.errors.filter((err) =>
      err.includes("agentEvaluations[0]") &&
      (err.includes("score") || err.includes("reasoning") || err.includes("issues"))
    );
    assertEquals(dimensionErrors.length > 0, true);
  });

  await t.step("should validate quality issue structures", async () => {
    const responseWithInvalidIssues = `\`\`\`json
{
  "sessionSuccess": false,
  "confidence": 75,
  "overallReasoning": "Issues detected",
  "agentEvaluations": [
    {
      "agentId": "agent-1",
      "individualSuccess": false,
      "completeness": {"score": 50, "reasoning": "Test", "issues": []},
      "accuracy": {"score": 50, "reasoning": "Test", "issues": []},
      "format": {"score": 50, "reasoning": "Test", "issues": []},
      "relevance": {"score": 50, "reasoning": "Test", "issues": []}
    }
  ],
  "successCriteriaEvaluation": [],
  "qualityIssues": [
    {
      "severity": "invalid-severity",
      "description": "",
      "affectedAgents": "not-an-array",
      "recommendation": "",
      "impact": "invalid-impact"
    }
  ],
  "nextAction": "retry",
  "actionReasoning": "Need retry"
}
\`\`\``;

    const result = await QualityAssessmentParser.parseQualityAssessment(
      responseWithInvalidIssues,
      ["agent-1"],
      "test-session",
    );

    assertEquals(result.isValid, false);

    // Should detect quality issue validation errors
    const issueErrors = result.errors.filter((err) => err.includes("qualityIssues[0]"));
    assertEquals(issueErrors.length > 0, true);
  });
});

// Test decision making
Deno.test("Quality Assessment Decision Making", async (t) => {
  await t.step("should make high-confidence completion decision", () => {
    const assessment: QualityAssessment = {
      sessionSuccess: true,
      confidence: 90,
      overallReasoning: "All criteria met successfully",
      agentEvaluations: [],
      successCriteriaEvaluation: [],
      qualityIssues: [],
      nextAction: "complete",
      actionReasoning: "Ready to complete",
    };

    const decision = QualityAssessmentParser.makeCompletionDecision(assessment);

    assertEquals(decision.isComplete, true);
    assertEquals(decision.nextAction, undefined); // complete becomes undefined
    assertExists(decision.feedback);
  });

  await t.step("should make conservative decision for medium confidence", () => {
    const assessment: QualityAssessment = {
      sessionSuccess: true,
      confidence: 65,
      overallReasoning: "Some uncertainty in evaluation",
      agentEvaluations: [],
      successCriteriaEvaluation: [],
      qualityIssues: [
        {
          severity: "critical",
          description: "Critical issue detected",
          affectedAgents: ["agent-1"],
          recommendation: "Retry execution",
          impact: "blocking",
        },
      ],
      nextAction: "complete",
      actionReasoning: "Attempting completion",
    };

    const decision = QualityAssessmentParser.makeCompletionDecision(assessment);

    // Should override to retry due to critical issues
    assertEquals(decision.isComplete, false);
    assertEquals(decision.nextAction, "retry");
  });

  await t.step("should escalate for low confidence", () => {
    const assessment: QualityAssessment = {
      sessionSuccess: true,
      confidence: 40,
      overallReasoning: "Significant uncertainty in assessment",
      agentEvaluations: [],
      successCriteriaEvaluation: [],
      qualityIssues: [],
      nextAction: "complete",
      actionReasoning: "Uncertain completion",
    };

    const decision = QualityAssessmentParser.makeCompletionDecision(assessment);

    assertEquals(decision.isComplete, false);
    assertEquals(decision.nextAction, "escalate");
    assertEquals(decision.feedback?.includes("Low confidence"), true);
    assertEquals(decision.feedback?.includes("Human review required"), true);
  });

  await t.step("should handle retry recommendations appropriately", () => {
    const assessment: QualityAssessment = {
      sessionSuccess: false,
      confidence: 85,
      overallReasoning: "Clear failures detected requiring retry",
      agentEvaluations: [],
      successCriteriaEvaluation: [],
      qualityIssues: [
        {
          severity: "major",
          description: "Agent output incomplete",
          affectedAgents: ["agent-1"],
          recommendation: "Retry with better parameters",
          impact: "degraded",
        },
      ],
      nextAction: "retry",
      actionReasoning: "Retry will likely resolve issues",
    };

    const decision = QualityAssessmentParser.makeCompletionDecision(assessment);

    assertEquals(decision.isComplete, false);
    assertEquals(decision.nextAction, "retry");
  });
});
