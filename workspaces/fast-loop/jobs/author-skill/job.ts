import {
  AuthorSkillInputSchema,
  SkillPlanResultSchema,
  SkillReviewResultSchema,
  SkillScaffoldResultSchema,
} from "./types.ts";

interface FsmContext {
  results: Record<string, Record<string, unknown>>;
  config?: Record<string, unknown>;
}

interface FsmEvent {
  data?: Record<string, unknown>;
}

export function prepare_plan(
  _context: FsmContext,
  event: FsmEvent,
): { task: string; config: Record<string, unknown> } {
  const parsed = AuthorSkillInputSchema.safeParse(event.data);
  if (!parsed.success) {
    throw new Error(`Invalid author-skill payload: ${parsed.error.message}`);
  }
  const { request, targetNamespace } = parsed.data;

  return { task: `Design a skill plan for: ${request}`, config: { request, targetNamespace } };
}

export function guard_plan_done(context: FsmContext, _event: FsmEvent): boolean {
  return context.results["plan-output"] !== undefined;
}

export function prepare_scaffold(
  context: FsmContext,
  _event: FsmEvent,
): { task: string; config: Record<string, unknown> } {
  const plan = context.results["plan-output"];
  if (!plan) throw new Error("Plan output not found");

  const parsed = SkillPlanResultSchema.safeParse(plan);
  if (!parsed.success) {
    throw new Error(`Invalid plan output: ${parsed.error.message}`);
  }

  return { task: `Scaffold skill "${parsed.data.name}" from plan`, config: { plan: parsed.data } };
}

export function guard_scaffold_done(context: FsmContext, _event: FsmEvent): boolean {
  return context.results["scaffold-output"] !== undefined;
}

export function prepare_review(
  context: FsmContext,
  _event: FsmEvent,
): { task: string; config: Record<string, unknown> } {
  const scaffold = context.results["scaffold-output"];
  const plan = context.results["plan-output"];
  if (!scaffold) throw new Error("Scaffold output not found");
  if (!plan) throw new Error("Plan output not found");

  const parsedScaffold = SkillScaffoldResultSchema.safeParse(scaffold);
  if (!parsedScaffold.success) {
    throw new Error(`Invalid scaffold output: ${parsedScaffold.error.message}`);
  }

  return {
    task: `Review skill "${parsedScaffold.data.name}" scaffold`,
    config: { scaffold: parsedScaffold.data, plan },
  };
}

export function guard_review_approved(context: FsmContext, _event: FsmEvent): boolean {
  const review = context.results["review-output"];
  if (!review) return false;

  const parsed = SkillReviewResultSchema.safeParse(review);
  if (!parsed.success) return false;

  return parsed.data.verdict === "APPROVE";
}

export function prepare_publish(
  context: FsmContext,
  _event: FsmEvent,
): { task: string; config: Record<string, unknown> } {
  const scaffold = context.results["scaffold-output"];
  const plan = context.results["plan-output"];
  if (!scaffold) throw new Error("Scaffold output not found");
  if (!plan) throw new Error("Plan output not found");

  const parsedScaffold = SkillScaffoldResultSchema.safeParse(scaffold);
  if (!parsedScaffold.success) {
    throw new Error(`Invalid scaffold output: ${parsedScaffold.error.message}`);
  }

  const parsedPlan = SkillPlanResultSchema.safeParse(plan);
  if (!parsedPlan.success) {
    throw new Error(`Invalid plan output: ${parsedPlan.error.message}`);
  }

  return {
    task: `Publish skill "${parsedScaffold.data.name}" via CLI`,
    config: { scaffold: parsedScaffold.data, plan: parsedPlan.data },
  };
}

export function guard_publish_done(context: FsmContext, _event: FsmEvent): boolean {
  return context.results["publish-output"] !== undefined;
}
