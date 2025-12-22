/**
 * Core FSM code generation function (Worker-free)
 *
 * Extracts the pure LLM generation logic for testing without Worker execution.
 * Agent uses this, evals use this.
 */

import type { WorkspacePlan } from "@atlas/core/artifacts";
import type { JSONSchema } from "@atlas/fsm-engine";
import { registry } from "@atlas/llm";
import { generateText } from "ai";
import { wrapAISDKModel } from "evalite/ai-sdk";
import { buildFSMGenerationPrompt } from "./agent-helpers.ts";
import type { SimplifiedAgent } from "./types.ts";

type WorkspaceJobPlan = WorkspacePlan["jobs"][0];
type WorkspaceSignal = WorkspacePlan["signals"][0];

/**
 * Generate FSM TypeScript code via LLM (no Worker execution)
 *
 * Pure function that calls LLM and returns generated code.
 * Suitable for testing in evalite without Worker dependency.
 *
 * @param job - Job plan from workspace
 * @param agents - Agents available for this job
 * @param triggerSignal - Signal that triggers this job
 * @param signalPayloadSchema - Optional JSON Schema defining signal payload structure
 * @param abortSignal - Optional abort signal
 * @returns Generated TypeScript code using FSMBuilder API
 */
export async function generateFSMCode(
  job: WorkspaceJobPlan,
  agents: SimplifiedAgent[],
  triggerSignal: WorkspaceSignal,
  signalPayloadSchema?: JSONSchema,
  abortSignal?: AbortSignal,
): Promise<string> {
  const prompt = buildFSMGenerationPrompt(job, agents, triggerSignal, signalPayloadSchema);

  const { text } = await generateText({
    model: wrapAISDKModel(registry.languageModel("groq:moonshotai/kimi-k2-instruct-0905")),
    prompt,
    temperature: 0.3, // Lower temperature for consistent code
    abortSignal,
  });

  return text;
}
