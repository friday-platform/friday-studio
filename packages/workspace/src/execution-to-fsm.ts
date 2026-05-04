/**
 * Compile a job's `execution.sequential` spec into a runtime FSM definition.
 *
 * The workspace runtime only knows how to execute FSM jobs. Workspaces
 * authored with the simpler `execution: { strategy: sequential, agents: [...] }`
 * shape previously fell through the runtime entirely — the chat agent saw the
 * jobs/signals via the config API, happily registered tool calls for them, and
 * then got 404 "Signal not found" at dispatch because no FSM state machine
 * handled the trigger.
 *
 * This compiler closes that gap by synthesizing a linear FSM:
 *
 *   idle --{trigger}--> step_0_<agent0> --ADVANCE--> step_1_<agent1> --...--> completed
 *
 * Signal payload is available to agents via `signal.data` directly.
 * The compiler intentionally only supports `strategy: "sequential"` — for
 * parallel or complex topologies, authors must use `fsm:` explicitly; there's
 * no silent best-effort fallback that would mask a misconfiguration.
 */

import type { JobExecutionAgent, JobSpecification } from "@atlas/config";
import type { FSMDefinition } from "@atlas/fsm-engine";

/**
 * Thrown when a job's `execution` block is structurally valid per the config
 * schema but not compilable into a runtime FSM — e.g., parallel strategy, no
 * agents, no trigger signal. Handled by the caller to log + skip the job
 * rather than crashing workspace initialization.
 */
export class ExecutionCompileError extends Error {
  constructor(
    readonly jobName: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionCompileError";
  }
}

/** Strip `{ id }` / string union down to the agent id. */
function agentId(spec: JobExecutionAgent): string {
  return typeof spec === "string" ? spec : spec.id;
}

/** State name for the Nth agent in the pipeline. Kept readable for logs/traces. */
function stepStateName(index: number, id: string): string {
  // Sanitize the agent id for use as a state key: state names appear in logs,
  // telemetry, and the FSM engine's transition lookup — colons or slashes
  // would confuse any consumer that splits on them.
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `step_${index}_${safe}`;
}

/**
 * Produce an FSM definition equivalent to `execution.sequential` on the given
 * job. Does NOT mutate the input job spec. Throws ExecutionCompileError when
 * the shape can't be compiled (caller decides whether to warn-and-skip or
 * surface to the user).
 */
export function compileExecutionToFsm(jobName: string, jobSpec: JobSpecification): FSMDefinition {
  const execution = jobSpec.execution;
  if (!execution) {
    throw new ExecutionCompileError(jobName, `has no 'execution' block`);
  }
  if (execution.strategy && execution.strategy !== "sequential") {
    throw new ExecutionCompileError(
      jobName,
      `execution.strategy='${execution.strategy}' is not supported at runtime yet. ` +
        `Use 'sequential' (default) or author the job as 'fsm:' directly.`,
    );
  }

  const agents = execution.agents ?? [];
  if (agents.length === 0) {
    throw new ExecutionCompileError(jobName, `execution.agents is empty`);
  }

  const triggerSignal = jobSpec.triggers?.[0]?.signal;
  if (!triggerSignal) {
    throw new ExecutionCompileError(
      jobName,
      `has 'execution' but no 'triggers' — synthesized FSM needs a signal to transition out of idle`,
    );
  }

  const agentIds = agents.map(agentId);
  const states: FSMDefinition["states"] = {
    idle: { on: { [triggerSignal]: { target: stepStateName(0, agentIds[0] as string) } } },
  };

  for (let i = 0; i < agentIds.length; i++) {
    const id = agentIds[i] as string;
    const nextTarget =
      i < agentIds.length - 1 ? stepStateName(i + 1, agentIds[i + 1] as string) : "completed";
    states[stepStateName(i, id)] = {
      entry: [
        { type: "agent", agentId: id },
        { type: "emit", event: "ADVANCE" },
      ],
      on: { ADVANCE: { target: nextTarget } },
    };
  }

  states.completed = { type: "final" };

  return { id: `${jobName}-sequential`, initial: "idle", states };
}
