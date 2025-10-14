export const SUPERVISOR_SYSTEM_PROMPT = `## Role
You make binary context inclusion decisions for agent execution in multi-agent workflows.

## Decision Framework
For each piece of context (signal payload, previous result), decide: include or exclude.
- Include: Information advances the target agent toward the workflow goal
- Exclude: Information is irrelevant to the target agent's task

## Analysis Process
1. **Parse the target agent's role**: Extract from system prompt what this agent does
2. **Identify workflow goal**: What outcome does this workflow achieve?
3. **Make inclusion decisions**:
   - Signal payload: Include if target agent's input source is "signal" or "combined"
   - Each previous result: Include if relevant to target agent's task AND workflow goal
   - Apply recency bias: Recent results are more likely relevant
   - When token budget is constrained (<25% available): Exclude borderline cases

4. **Format the output**:
   - Single coherent context string
   - Workflow intent first
   - Relevant signal payload second
   - Previous results last (most recent first)
   - For each included result: task, summary, artifact refs (id, type, summary)
   - Use markdown formatting for clarity

## Expanded Artifacts (Special Case)
If "Expanded Artifacts" section appears in the input, copy those JSON blocks verbatim into your optimizedContext. Do not modify structure, keys, or values. Label clearly so downstream agents can find them.

## Output Requirements
Return structured JSON with:
- \`optimizedContext\`: The formatted context string
- \`metadata.tokenEstimate\`: Approximate token count
- \`metadata.includedSignal\`: Boolean
- \`metadata.includedPreviousCount\`: Integer count
- \`reasoning\`: 2-3 sentences explaining key inclusion/exclusion decisions

## Core Principle
Binary decisions. Minimal tokens. Maximum signal for the target agent's specific task.`;

export interface SupervisorInput {
  workflowIntent: string;
  agentSystemPrompt: string;
  agentInputSource: "signal" | "previous" | "combined";
  signalPayload: unknown;
  previousResults: Array<{
    agentId: string;
    task: string;
    output: unknown;
    artifactRefs?: Array<{ id: string; type: string; summary: string }>;
  }>;
  tokenBudget: { modelLimit: number; defaultBudget: number; currentUsage: number };
}

export function buildOptimizationPrompt(
  input: SupervisorInput,
  opts?: { expandedArtifacts?: unknown[] },
): string {
  const available = input.tokenBudget.modelLimit - input.tokenBudget.currentUsage;
  const percentAvailable = ((available / input.tokenBudget.defaultBudget) * 100).toFixed(0);

  return `Make context inclusion decisions for this agent.

## Workflow Intent
${input.workflowIntent}

## Target Agent Configuration
- Role: ${input.agentSystemPrompt}
- Input Source: ${input.agentInputSource}
- What it needs: [Extract from system prompt what information this agent needs to succeed]

## Signal Payload
${JSON.stringify(input.signalPayload, null, 2)}

## Previous Results (${input.previousResults.length} available)
${
  input.previousResults.length === 0
    ? "None - this is the first agent in the workflow"
    : input.previousResults
        .map(
          (r, i) => `
### Result ${i + 1}: ${r.agentId}
Task: ${r.task}
Output: ${JSON.stringify(r.output)}
${
  r.artifactRefs?.length
    ? `Artifacts:\n${r.artifactRefs.map((a) => `- ${a.type} (${a.id}): ${a.summary}`).join("\n")}`
    : "No artifacts"
}
`,
        )
        .join("\n")
}

## Token Budget
- Model Limit: ${input.tokenBudget.modelLimit}
- Current Usage: ${input.tokenBudget.currentUsage}
- Available: ${available} (${percentAvailable}% of default budget)
- Constraint: ${Number(percentAvailable) < 25 ? "TIGHT - be selective" : "Adequate - include relevant context"}

${
  opts?.expandedArtifacts?.length
    ? `## Expanded Artifacts (copy verbatim - do not modify)
${opts.expandedArtifacts
  .map(
    (a, i) => `### Artifact ${i + 1}
\`\`\`json
${JSON.stringify(a, null, 2)}
\`\`\``,
  )
  .join("\n\n")}
`
    : ""
}

Analyze the target agent's needs, make binary inclusion decisions, format the optimized context, and explain your reasoning.`;
}
