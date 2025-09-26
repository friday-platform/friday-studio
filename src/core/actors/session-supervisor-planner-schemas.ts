import { z } from "zod/v4";

export const AgentTaskSchema = z.object({
  agentId: z.string().min(1, "agentId required"),
  task: z.string().min(1, "task required"),
  reasoning: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  order: z.number().optional(),
  inputSource: z
    .enum(["signal", "previous", "combined"] as const)
    .default("signal")
    .catch("signal"),
});

export const ExecutionPhaseSchema = z.object({
  id: z.string().min(1).catch(""),
  name: z.string().min(1),
  executionStrategy: z
    .enum(["sequential", "parallel"] as const)
    .default("sequential")
    .catch("sequential"),
  agents: z.array(AgentTaskSchema).min(1),
  reasoning: z.string().optional(),
});

export const ReasoningStepSchema = z.object({
  iteration: z.number().int().nonnegative().catch(0),
  thinking: z.string().default("").catch(""),
  action: z.string().default("").catch(""),
  observation: z.string().default("").catch(""),
});

export const ExecutionPlanSchema = z.object({
  id: z.string().min(1).catch(""),
  phases: z.array(ExecutionPhaseSchema).min(1),
  reasoning: z.string().default("").catch(""),
  strategy: z.string().default("ai-planned").catch("ai-planned"),
  confidence: z.coerce.number().min(0).max(1).default(0.8).catch(0.8),
  reasoningSteps: z.array(ReasoningStepSchema).default([]).catch([]),
});
