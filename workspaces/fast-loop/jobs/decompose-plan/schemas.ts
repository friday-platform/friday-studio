import { z } from "zod";

/** Signal payload for the decompose-plan FSM. */
export const DecomposePlanSignalSchema = z.object({
  plan_path: z.string(),
  scope: z.string().optional(),
  default_target: z.object({ workspace_id: z.string(), signal_id: z.string() }),
  dry_run: z.boolean().optional(),
});

export type DecomposePlanSignal = z.infer<typeof DecomposePlanSignalSchema>;

/** A single task proposed by the plan decomposer agent. */
export const ProposedTaskSchema = z.object({
  task_id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  subject: z.string().min(1),
  task_brief: z.string().min(1),
  target_files: z.array(z.string()),
  blocked_by: z.array(z.string()),
  priority: z.number().int(),
  is_tracer: z.boolean(),
  target_workspace_id: z.string().optional(),
  target_signal_id: z.string().optional(),
  plan_section: z.string().optional(),
});

export type ProposedTask = z.infer<typeof ProposedTaskSchema>;

/** Full output of the decomposer agent (outputType: decomposer-result). */
export const DecomposerResultSchema = z.object({
  batch_id: z.string(),
  plan_ref: z.object({ path: z.string(), scope: z.string().optional(), sha: z.string() }),
  default_target: z.object({ workspace_id: z.string(), signal_id: z.string() }),
  tasks: z.array(ProposedTaskSchema).min(1),
});

export type DecomposerResult = z.infer<typeof DecomposerResultSchema>;

/** An integrity check finding — all failures are BLOCK severity in MVP. */
export const IntegrityFindingSchema = z.object({
  rule: z.enum([
    "no_cycles",
    "blocked_by_resolves",
    "non_empty_content",
    "tracer_discipline",
    "target_files_resolve",
  ]),
  severity: z.literal("BLOCK"),
  task_id: z.string().optional(),
  detail: z.string(),
});

export type IntegrityFinding = z.infer<typeof IntegrityFindingSchema>;
