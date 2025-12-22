/**
 * FSM Workspace Creator Eval
 *
 * Tests FSM code generation across diverse workspace types.
 * Validates TypeScript compilation and semantic correctness.
 */

import type { WorkspacePlan } from "@atlas/core/artifacts";
import type { Evalite } from "evalite";
import { evalite } from "evalite";
import { classifyAgents } from "../../../packages/system/agents/fsm-workspace-creator/agent-classifier.ts";
import { flattenAgent } from "../../../packages/system/agents/fsm-workspace-creator/agent-helpers.ts";
import { generateFSMCode } from "../../../packages/system/agents/fsm-workspace-creator/fsm-generation-core.ts";
import { LLMJudge } from "../lib/llm-judge.ts";
import { loadCredentials } from "../lib/load-credentials.ts";
import { checkTypeScriptCompilation } from "../lib/typescript-checker.ts";
import {
  customerSupportTriagePlan,
  githubCIPipelinePlan,
  githubPRWebhookPlan,
  investorBriefingPlan,
} from "./workspace-creation/plans/mod.ts";

await loadCredentials();

type EvalInput = { plan: WorkspacePlan };
type EvalOutput = { code: string; compiles: boolean; errors: string[] };

/**
 * Scorer: TypeScript Compilation
 * Binary: pass = 1, fail = 0
 */
const CompilationScorer: Evalite.ScorerOpts<EvalInput, EvalOutput, string> = {
  name: "TypeScript Compilation",
  scorer: ({ output }) => (output.compiles ? 1 : 0),
};

/**
 * LLM Judge Scorer: Semantic Correctness
 * Evaluates if generated FSM code matches job plan intent
 */
const SemanticJudgeScorer: Evalite.ScorerOpts<EvalInput, EvalOutput, string> = {
  name: "Semantic Correctness",
  scorer: async ({ input, output }) => {
    const job = input.plan.jobs[0];
    if (!job) {
      return { score: 0, description: "No job found in plan" };
    }

    const signal = input.plan.signals.find((s) => s.id === job.triggerSignalId);

    const expected = `
Job Plan:
- Name: ${job.name}
- Description: ${job.steps.map((s: { description: string }) => s.description).join(" → ")}
- Steps: ${job.steps.map((s: { agentId: string }) => s.agentId).join(" → ")}
- Trigger: ${signal?.name || "unknown"}

Evaluate if the generated FSM code correctly implements this plan:
1. Has states for each step in the job
2. Calls correct agents with proper actions
3. Transitions flow logically
4. Handles trigger signal correctly
5. No obvious logic errors
`.trim();

    const result = await LLMJudge({ output: output.code, expected, input: undefined });

    return { ...result, score: result.score ?? 0 };
  },
};

/**
 * FSM Workspace Creator Eval
 *
 * Tests FSM code generation across 4 diverse workspace types.
 * Each test validates both compilation and semantic correctness.
 */
evalite<EvalInput, EvalOutput, string>("FSM Workspace Creator", {
  data: [
    { input: { plan: customerSupportTriagePlan }, expected: "compiles=true, semantic_score>=80" },
    { input: { plan: githubCIPipelinePlan }, expected: "compiles=true, semantic_score>=80" },
    { input: { plan: githubPRWebhookPlan }, expected: "compiles=true, semantic_score>=80" },
    { input: { plan: investorBriefingPlan }, expected: "compiles=true, semantic_score>=80" },
  ],
  task: async (input) => {
    const job = input.plan.jobs[0];
    if (!job) {
      throw new Error("No job found in plan");
    }

    const signal = input.plan.signals.find((s) => s.id === job.triggerSignalId);
    if (!signal) {
      throw new Error(`Signal ${job.triggerSignalId} not found in plan`);
    }

    // Classify and flatten agents (same as agent does)
    const classifiedAgents = classifyAgents(input.plan);
    const jobAgents = classifiedAgents
      .filter((a) => job.steps.some((s) => s.agentId === a.id))
      .map(flattenAgent);

    // Generate FSM code via LLM
    const code = await generateFSMCode(job, jobAgents, signal);

    // Check TypeScript compilation
    const compilationResult = await checkTypeScriptCompilation(code);

    return { code, compiles: compilationResult.success, errors: compilationResult.errors };
  },
  scorers: [CompilationScorer, SemanticJudgeScorer],
  columns: ({ input, output }) => [
    { label: "Workspace", value: input.plan.workspace.name },
    { label: "Job", value: input.plan.jobs[0]?.name || "N/A" },
    { label: "Compiles", value: output.compiles ? "✓" : "✗" },
    {
      label: "Errors",
      value: output.errors.length > 0 ? (output.errors[0] ?? "").slice(0, 200) : "None",
    },
    { label: "Code Length", value: `${output.code.length} chars` },
  ],
});
