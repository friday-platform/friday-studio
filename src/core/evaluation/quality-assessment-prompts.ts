/**
 * Enhanced Quality Assessment Prompts
 *
 * Advanced prompts for structured LLM evaluation to replace keyword-based detection
 * in SessionSupervisor. Incorporates best practices from prompting techniques and
 * trustworthy AI patterns.
 */

import { AgentResult, ExecutionPlan, SessionContext } from "../session-supervisor.ts";
import { QualityAssessment } from "../interfaces/quality-assessment.ts";

export class QualityAssessmentPrompts {
  /**
   * Generate the comprehensive system prompt for quality assessment
   */
  static generateSystemPrompt(): string {
    return `# Quality Assessment System Prompt

You are a Quality Assessment Analyst responsible for evaluating the success of multi-agent job execution. Your analysis must be thorough, objective, and structured.

## CORE RESPONSIBILITIES
1. **Structured Analysis**: Evaluate results across multiple quality dimensions
2. **Evidence-Based Assessment**: Base conclusions on observable facts from agent outputs
3. **Safety-First Approach**: Identify potential risks and quality issues
4. **Actionable Recommendations**: Provide clear next steps based on assessment

## EVALUATION FRAMEWORK

Analyze the session results across these critical dimensions:

### 1. **COMPLETENESS ANALYSIS**
- Did each agent produce the expected type of output?
- Are all required fields/components present?
- Did agents address all aspects of their assigned tasks?
- Is the output scope sufficient for the requirements?

### 2. **ACCURACY ANALYSIS**  
- Are the agent outputs factually correct?
- Do outputs align with the original signal intent?
- Are there logical inconsistencies or contradictions?
- Do calculations, references, or data transformations appear correct?

### 3. **FORMAT VALIDATION**
- Do outputs conform to expected schemas/formats?
- Are data types correct (JSON, text, numbers, etc.)?
- Is structured data properly formatted and parseable?
- Are required fields present with valid values?

### 4. **RELEVANCE ASSESSMENT**
- Do outputs directly address the signal objectives?
- Are outputs actionable and useful for the intended purpose?
- Do outputs maintain focus on the core requirements?
- Is there unnecessary or off-topic content?

## SAFETY CONSTRAINTS
- Never approve outputs that could compromise system integrity
- Always flag potential security risks or data exposure
- Escalate to human oversight when uncertain about safety implications
- Maintain audit logs for all assessment decisions
- Be explicit about confidence levels and limitations

## EVALUATION METHODOLOGY

For each agent result, provide:

1. **Output Summary**: Brief description of what the agent produced
2. **Success Indicators**: Specific evidence of successful completion
3. **Quality Issues**: Any problems, gaps, or concerns identified
4. **Completeness Check**: Verification against success criteria
5. **Confidence Assessment**: How certain you are about this evaluation

## CRITICAL INSTRUCTIONS

- **Be Specific**: Reference actual output content, not general statements
- **Use Evidence**: Base conclusions on observable facts from agent outputs
- **Consider Context**: Evaluate outputs in relation to the original signal/task
- **Acknowledge Uncertainty**: Flag areas where you're not confident
- **Focus on Objectives**: Success means the signal objectives were achieved
- **Chain of Thought**: Think step-by-step through your analysis
- **No Hallucination**: Only reference data that is actually present

## CONFIDENCE CALIBRATION

When assigning confidence scores, use this calibration:

**90-100%: Very High Confidence**
- All outputs clearly successful or clearly failed
- Success criteria explicitly met or violated
- No ambiguity in evaluation

**70-89%: High Confidence**  
- Clear success/failure indicators present
- Minor ambiguities that don't affect overall assessment
- Strong evidence supporting conclusion

**50-69%: Medium Confidence**
- Mixed signals in outputs
- Some success criteria met, others unclear
- Requires human judgment for edge cases

**30-49%: Low Confidence**
- Ambiguous outputs that could be interpreted multiple ways
- Success criteria partially met with unclear implications
- Significant uncertainty about quality

**0-29%: Very Low Confidence**
- Insufficient information to make assessment
- Conflicting evidence
- Requires additional context or human review

## ESCALATION CONDITIONS

Escalate to human oversight when:
- Confidence level below 50%
- Potential security implications detected
- Novel situations without precedent
- Conflicting agent outputs that cannot be resolved
- Resource limits exceeded significantly

## OUTPUT FORMAT

**CRITICAL**: You MUST provide your assessment in this exact JSON structure. No other format will be accepted:

\`\`\`json
{
  "sessionSuccess": boolean,
  "confidence": number, // 0-100
  "overallReasoning": "Step-by-step explanation of overall assessment",
  "agentEvaluations": [
    {
      "agentId": "agent-name",
      "individualSuccess": boolean,
      "completeness": {
        "score": number, // 0-100
        "reasoning": "Why this score was assigned",
        "issues": ["list", "of", "specific", "gaps"],
        "evidence": ["specific", "evidence", "supporting", "score"]
      },
      "accuracy": {
        "score": number,
        "reasoning": "Assessment of correctness",
        "issues": ["list", "of", "accuracy", "problems"],
        "evidence": ["specific", "evidence", "for", "accuracy"]
      },
      "format": {
        "score": number,
        "reasoning": "Format validation results",
        "issues": ["list", "of", "format", "problems"],
        "evidence": ["specific", "format", "validation", "results"]
      },
      "relevance": {
        "score": number,
        "reasoning": "How well output addresses requirements",
        "issues": ["list", "of", "relevance", "problems"],
        "evidence": ["specific", "relevance", "indicators"]
      },
      "outputSummary": "Brief description of what this agent produced"
    }
  ],
  "successCriteriaEvaluation": [
    {
      "criterion": "exact text of the success criterion",
      "met": boolean,
      "evidence": "Specific evidence for this determination",
      "reasoning": "Why this criterion was/wasn't met",
      "confidence": number // 0-100
    }
  ],
  "qualityIssues": [
    {
      "severity": "critical|major|minor",
      "description": "Clear description of the issue",
      "affectedAgents": ["list", "of", "agent", "ids"],
      "recommendation": "Specific recommendation to address this issue",
      "impact": "blocking|degraded|cosmetic"
    }
  ],
  "nextAction": "complete|retry|adapt|escalate",
  "actionReasoning": "Why this next action is recommended based on the analysis"
}
\`\`\`

**VALIDATION REQUIREMENTS**:
- confidence must be 0-100
- nextAction must be exactly one of: complete, retry, adapt, escalate  
- All scores must be 0-100
- severity must be exactly one of: critical, major, minor
- impact must be exactly one of: blocking, degraded, cosmetic
- All reasoning fields must be non-empty strings
- agentEvaluations must contain an entry for every agent that executed

Never provide assessment without this complete JSON structure.`;
  }

  /**
   * Generate the context-rich evaluation input template
   */
  static generateEvaluationPrompt(
    sessionContext: SessionContext,
    executionPlan: ExecutionPlan,
    results: AgentResult[],
  ): string {
    const eventDetails = this.extractEventDetails(sessionContext);
    const successCriteria = executionPlan.successCriteria || [];
    const formattedResults = this.formatAgentResultsForEvaluation(
      results,
      sessionContext,
      executionPlan,
    );

    return `# Session Quality Evaluation Request

## SESSION CONTEXT
**Signal ID**: ${sessionContext.signal.id}
**Signal Type**: ${(sessionContext.signal as any).type || "unknown"}
**Workspace**: ${sessionContext.workspaceId}
**Session Objectives**: ${this.formatObjectives(sessionContext)}
**Execution Strategy**: ${executionPlan.adaptationStrategy}

${eventDetails}

## SUCCESS CRITERIA ANALYSIS REQUIRED
${
      successCriteria.length > 0
        ? successCriteria.map((criterion, index) =>
          `### Criterion ${index + 1}: ${criterion}
**Evaluation Required**: Determine if this criterion is met based on agent outputs
**Evidence Needed**: Specific references to agent outputs that support your conclusion`
        ).join("\n\n")
        : "### Default Criteria:\n- Execute all planned agents successfully\n- Produce meaningful outputs from each agent"
    }

## AGENT EXECUTION RESULTS

Total Agents Planned: ${this.calculateTotalAgentsInPlan(executionPlan)}
Total Agents Executed: ${results.length}

${formattedResults}

## EVALUATION INSTRUCTIONS

You must provide a comprehensive quality assessment following your system prompt format.

**Step-by-Step Analysis Required**:

**Step 1: Execution Completeness**
- Have all planned agents executed?
- If not, what is the execution status?

**Step 2: Individual Agent Assessment**
- For each agent, evaluate completeness, accuracy, format, and relevance
- Identify specific issues with evidence

**Step 3: Success Criteria Validation**  
- For each criterion, determine if it's met with specific evidence
- Explain reasoning for each determination

**Step 4: Quality Issue Identification**
- Identify any critical, major, or minor issues
- Provide specific recommendations for each issue

**Step 5: Overall Decision**
- Determine session success based on analysis
- Choose appropriate next action with reasoning

**Decision Criteria**:
- **Complete**: All success criteria met + no critical issues + confidence ≥ 70%
- **Retry**: Critical issues identified that could be fixed with re-execution  
- **Adapt**: Success criteria partially met, execution plan needs modification
- **Escalate**: Low confidence (<50%) or complex issues requiring human judgment

**CRITICAL**: Base your assessment only on the actual data provided. Do not make assumptions about missing information.

Provide the complete JSON assessment now:`;
  }

  /**
   * Generate a confidence validation prompt for self-assessment
   */
  static generateConfidenceValidationPrompt(assessment: QualityAssessment): string {
    return `# Confidence Validation Check

Review your assessment and validate your confidence score:

## Your Assessment Summary
- Session Success: ${assessment.sessionSuccess}
- Confidence: ${assessment.confidence}%
- Next Action: ${assessment.nextAction}
- Quality Issues: ${assessment.qualityIssues?.length || 0} issues identified

## Confidence Validation Questions

1. **Evidence Quality**: Are all your conclusions based on specific, observable evidence from the agent outputs?

2. **Certainty Level**: How certain are you about each major decision point?
   - Session success determination
   - Individual agent assessments  
   - Success criteria evaluations

3. **Missing Information**: Are there any important aspects you couldn't evaluate due to missing information?

4. **Conflicting Signals**: Are there any contradictory indicators that create uncertainty?

5. **Novel Situations**: Does this scenario involve any unfamiliar patterns that reduce confidence?

## Confidence Adjustment

If any of the above factors indicate lower certainty than your assigned confidence score, consider adjusting downward:

- **Reduce by 10-20%**: Minor uncertainties or single ambiguous outputs
- **Reduce by 20-30%**: Multiple ambiguities or missing key information
- **Reduce to <50%**: Significant uncertainties requiring human review

Provide your final confidence assessment with reasoning for any adjustments.`;
  }

  /**
   * Helper method to extract event details from session context
   */
  private static extractEventDetails(sessionContext: SessionContext): string {
    if (!sessionContext.payload) {
      return "**Event Details**: No specific event data available";
    }

    const payload = sessionContext.payload;

    // Handle Kubernetes events
    if (payload.event) {
      return `**Event Details**:
- Event Type: ${payload.event.type || "Unknown"}
- Resource: ${payload.event.involvedObject?.kind || "Unknown"} 
- Name: ${payload.event.name || payload.event.involvedObject?.name || "Unknown"}
- Namespace: ${payload.event.namespace || "default"}
- Reason: ${payload.event.reason || "Unknown"}
- Message: ${payload.event.message || "No message"}`;
    }

    // Handle other payload types
    return `**Event Details**:
- Payload Type: ${payload.type || "Unknown"}
- Raw Data Summary: ${JSON.stringify(payload, null, 2).slice(0, 500)}${
      JSON.stringify(payload).length > 500 ? "..." : ""
    }`;
  }

  /**
   * Helper method to format session objectives
   */
  private static formatObjectives(sessionContext: SessionContext): string {
    if (sessionContext.jobSpec?.description) {
      return sessionContext.jobSpec.description;
    }

    if (sessionContext.filteredMemory?.length) {
      return `Process ${sessionContext.signal.id} signal with available context`;
    }

    return `Execute agents for ${sessionContext.signal.id} signal`;
  }

  /**
   * Helper method to calculate total agents in execution plan
   */
  private static calculateTotalAgentsInPlan(executionPlan: ExecutionPlan): number {
    return executionPlan.phases.reduce((sum, phase) => sum + phase.agents.length, 0);
  }

  /**
   * Helper method to format agent results for evaluation
   */
  private static formatAgentResultsForEvaluation(
    results: AgentResult[],
    sessionContext: SessionContext,
    executionPlan: ExecutionPlan,
  ): string {
    if (results.length === 0) {
      return "**No agent results to evaluate** - This may indicate:\n- Execution plan has no agents\n- Agents failed to execute\n- Technical failure preventing result collection";
    }

    return results.map((result, index) => {
      const expectedOutputType = this.getExpectedOutputType(
        result.agentId,
        sessionContext,
        executionPlan,
      );
      const outputPreview = this.formatOutputPreview(result.output);

      return `### Agent Execution ${index + 1}: ${result.agentId}

**Assigned Task**: ${result.task}
**Execution Time**: ${result.duration}ms
**Expected Output Type**: ${expectedOutputType}
**Execution Status**: ${result.output ? "Completed with output" : "Completed with no output"}

**Input Context**:
\`\`\`json
${JSON.stringify(result.input, null, 2)}
\`\`\`

**Actual Output**:
\`\`\`json
${outputPreview}
\`\`\`

**Quality Checkpoints for This Agent**:
- Is output non-empty and properly formatted?
- Does output address the assigned task?
- Is output consistent with input context?
- Does output contribute to session objectives?
- Are all expected fields/components present?

${result.timestamp ? `**Timestamp**: ${result.timestamp}` : ""}`;
    }).join("\n---\n");
  }

  /**
   * Helper method to get expected output type for an agent
   */
  private static getExpectedOutputType(
    agentId: string,
    sessionContext: SessionContext,
    executionPlan: ExecutionPlan,
  ): string {
    // Look for agent in execution plan for expected output info
    for (const phase of executionPlan.phases) {
      const agentTask = phase.agents.find((agent) => agent.agentId === agentId);
      if (agentTask) {
        return agentTask.config?.expectedOutput || "JSON object";
      }
    }

    // Look in available agents metadata
    const agentMetadata = sessionContext.availableAgents.find((agent) => agent.id === agentId);
    if (agentMetadata) {
      if (agentMetadata.type === "llm") {
        return "Text or structured response";
      } else if (agentMetadata.type === "remote") {
        return "Remote service response";
      } else if (agentMetadata.type === "tempest") {
        return "Tempest agent output";
      }
    }

    return "Unknown - no metadata available";
  }

  /**
   * Helper method to format output preview (handling large or null outputs)
   */
  private static formatOutputPreview(output: unknown): string {
    if (output === null || output === undefined) {
      return "null";
    }

    try {
      const jsonString = JSON.stringify(output, null, 2);

      // Truncate very large outputs
      if (jsonString.length > 2000) {
        return jsonString.slice(0, 2000) + "\n... (output truncated)";
      }

      return jsonString;
    } catch (error) {
      return `"Error serializing output: ${error.message}"`;
    }
  }

  /**
   * Generate a fallback assessment prompt for when structured evaluation fails
   */
  static generateFallbackAssessmentPrompt(
    results: AgentResult[],
    executionPlan: ExecutionPlan,
  ): string {
    return `# Fallback Quality Assessment

**Situation**: Structured evaluation failed, performing basic assessment.

## Basic Validation Checks

**Agent Execution Status**:
- Total agents planned: ${this.calculateTotalAgentsInPlan(executionPlan)}
- Total agents executed: ${results.length}
- Execution completion: ${
      results.length >= this.calculateTotalAgentsInPlan(executionPlan) ? "Complete" : "Incomplete"
    }

**Output Validation**:
${
      results.map((result, index) =>
        `Agent ${index + 1} (${result.agentId}): ${
          result.output ? "Has output" : "No output"
        } (${result.duration}ms)`
      ).join("\n")
    }

**Basic Quality Indicators**:
- Empty outputs: ${
      results.filter((r) => !r.output || Object.keys(r.output || {}).length === 0).length
    }
- Error patterns: ${results.filter((r) => this.hasErrorPatterns(r.output)).length}
- Execution timeouts: ${results.filter((r) => r.duration > 30000).length}

## Assessment Result

Based on basic validation, recommend:
- **Continue**: If not all agents executed
- **Complete**: If all agents executed with non-empty outputs and no error patterns
- **Retry**: If error patterns or empty outputs detected
- **Escalate**: If unable to determine status reliably

This fallback assessment should be followed by human review for quality validation.`;
  }

  /**
   * Helper method to detect error patterns in output
   */
  private static hasErrorPatterns(output: unknown): boolean {
    if (!output) return false;

    const outputStr = JSON.stringify(output).toLowerCase();
    return outputStr.includes("error:") ||
      outputStr.includes("failed to") ||
      outputStr.includes("exception") ||
      outputStr.includes("timeout") ||
      outputStr.includes("null") && outputStr.includes("error");
  }
}
