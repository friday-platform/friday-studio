import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WorkspaceConfigSchema, WorkspaceSignalConfigSchema } from "@atlas/config";
import { parse } from "@std/yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const workspaceYmlPath = resolve(
  import.meta.dirname ?? ".",
  "../../../../workspaces/system/workspace.yml",
);

const ExtendWorkspacePayloadSchema = z.strictObject({
  targetWorkspaceId: z.string().min(1),
  additions: z
    .strictObject({ signals: z.record(z.string(), WorkspaceSignalConfigSchema).optional() })
    .refine((a) => a.signals && Object.keys(a.signals).length > 0, {
      message: "At least one signal addition required",
    }),
});

const ValidateResultSchema = z.strictObject({
  valid: z.boolean(),
  issues: z.array(z.string()),
  resolvedSignals: z.record(z.string(), WorkspaceSignalConfigSchema),
});

const ApplyResultSchema = z.strictObject({
  applied: z.boolean(),
  created: z.array(z.string()),
  errors: z.array(z.string()),
  summary: z.string(),
});

function makeContext(results: Record<string, unknown> = {}) {
  const stored: Record<string, unknown> = { ...results };
  return {
    results: stored,
    setResult(key: string, value: unknown) {
      stored[key] = value;
    },
    config: {},
  };
}

function makeEvent(data: Record<string, unknown> = {}) {
  return { data };
}

type FsmFn = (ctx: ReturnType<typeof makeContext>, evt: ReturnType<typeof makeEvent>) => unknown;

function extractFsmFunctions(yml: string): Map<string, FsmFn> {
  const config = parse(yml) as Record<string, unknown>;
  const jobs = config.jobs as Record<string, Record<string, unknown>>;
  const job = jobs["extend-workspace"] ?? {};
  const fsm = (job.fsm ?? {}) as Record<string, unknown>;
  const fns = (fsm.functions ?? {}) as Record<string, { type: string; code: string }>;

  const extracted = new Map<string, FsmFn>();
  for (const [name, def] of Object.entries(fns)) {
    const code = def.code;
    const moduleMatch = code.match(/export default function (\w+)/);
    if (moduleMatch) {
      const fnName = moduleMatch[1];
      const strippedCode = code.replace(/export default /, "");
      const wrapped = strippedCode + `\nreturn ${fnName};`;
      const factory = new Function(wrapped);
      extracted.set(name, factory() as FsmFn);
    }
  }
  return extracted;
}

function getFn(fns: Map<string, FsmFn>, name: string): FsmFn {
  const fn = fns.get(name);
  if (!fn) throw new Error(`FSM function '${name}' not found`);
  return fn;
}

describe("extend-workspace job — workspace.yml schema validation", () => {
  const raw = readFileSync(workspaceYmlPath, "utf-8");
  const parsed = parse(raw) as Record<string, unknown>;

  it("parses the full workspace.yml through WorkspaceConfigSchema", () => {
    const result = WorkspaceConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `WorkspaceConfigSchema parse failed:\n${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("contains the extend-workspace signal with http provider", () => {
    const signals = parsed.signals as Record<string, Record<string, unknown>>;
    const signal = signals["extend-workspace"] ?? {};
    expect(signal).toBeDefined();
    expect(signal.provider).toBe("http");
  });

  it("contains the extend-workspace job with FSM", () => {
    const jobs = parsed.jobs as Record<string, Record<string, unknown>>;
    const job = jobs["extend-workspace"] ?? {};
    expect(job).toBeDefined();
    expect(job.fsm).toBeDefined();
    const fsm = (job.fsm ?? {}) as Record<string, unknown>;
    expect(fsm.id).toBe("extend-workspace-pipeline");
    expect(fsm.initial).toBe("idle");
  });

  it("contains the three extend agents", () => {
    const agents = parsed.agents as Record<string, Record<string, unknown>>;
    expect(agents["extend-validator"]).toBeDefined();
    expect(agents["extend-reviewer"]).toBeDefined();
    expect(agents["extend-applier"]).toBeDefined();
    for (const id of ["extend-validator", "extend-reviewer", "extend-applier"]) {
      const agent = agents[id] ?? {};
      expect(agent.type).toBe("atlas");
      expect(agent.agent).toBe("claude-code");
    }
  });

  it("FSM has correct state progression: idle → step_validate → step_review → step_apply → completed", () => {
    const jobs = parsed.jobs as Record<string, Record<string, unknown>>;
    const job = jobs["extend-workspace"] ?? {};
    const fsm = (job.fsm ?? {}) as Record<string, Record<string, unknown>>;
    const states = (fsm.states ?? {}) as Record<string, Record<string, unknown>>;
    expect(Object.keys(states)).toEqual(
      expect.arrayContaining(["idle", "step_validate", "step_review", "step_apply", "completed"]),
    );
    const completed = (states.completed ?? {}) as Record<string, unknown>;
    expect(completed.type).toBe("final");
  });
});

describe("extend-workspace FSM code functions", () => {
  const raw = readFileSync(workspaceYmlPath, "utf-8");
  const fns = extractFsmFunctions(raw);

  describe("prepare_validate", () => {
    it("returns task + config shape with valid input", () => {
      const ctx = makeContext();
      const evt = makeEvent({
        targetWorkspaceId: "test-ws",
        additions: {
          signals: {
            "my-signal": {
              provider: "http",
              description: "Test signal",
              config: { path: "/webhooks/test" },
            },
          },
        },
      });
      const result = getFn(fns, "prepare_validate")(ctx, evt) as Record<string, unknown>;
      expect(result.task).toContain("test-ws");
      expect(result.config).toBeDefined();
      const config = result.config as Record<string, unknown>;
      expect(config.targetWorkspaceId).toBe("test-ws");
      expect(config.additions).toBeDefined();
      expect(config.platformUrl).toBe("http://localhost:8080");
    });

    it("stashes extend-input in context", () => {
      const ctx = makeContext();
      const evt = makeEvent({
        targetWorkspaceId: "test-ws",
        additions: {
          signals: { s1: { provider: "http", description: "d", config: { path: "/p" } } },
        },
      });
      getFn(fns, "prepare_validate")(ctx, evt);
      expect(ctx.results["extend-input"]).toBeDefined();
      const input = ctx.results["extend-input"] as Record<string, unknown>;
      expect(input.targetWorkspaceId).toBe("test-ws");
    });

    it("throws on missing targetWorkspaceId", () => {
      const ctx = makeContext();
      const evt = makeEvent({ additions: { signals: {} } });
      expect(() => getFn(fns, "prepare_validate")(ctx, evt)).toThrow("targetWorkspaceId");
    });

    it("throws on missing additions", () => {
      const ctx = makeContext();
      const evt = makeEvent({ targetWorkspaceId: "ws" });
      expect(() => getFn(fns, "prepare_validate")(ctx, evt)).toThrow("additions");
    });

    it("rejects additions with agents key (not yet supported)", () => {
      const ctx = makeContext();
      const evt = makeEvent({
        targetWorkspaceId: "ws",
        additions: { agents: { a: {} }, signals: { s: {} } },
      });
      expect(() => getFn(fns, "prepare_validate")(ctx, evt)).toThrow("not yet supported");
    });

    it("rejects additions with jobs key (not yet supported)", () => {
      const ctx = makeContext();
      const evt = makeEvent({
        targetWorkspaceId: "ws",
        additions: { jobs: { j: {} }, signals: { s: {} } },
      });
      expect(() => getFn(fns, "prepare_validate")(ctx, evt)).toThrow("not yet supported");
    });

    it("rejects empty signals object", () => {
      const ctx = makeContext();
      const evt = makeEvent({ targetWorkspaceId: "ws", additions: { signals: {} } });
      expect(() => getFn(fns, "prepare_validate")(ctx, evt)).toThrow("At least one signal");
    });
  });

  describe("guard_validate_done", () => {
    it("returns true when validate-output exists and valid===true", () => {
      const ctx = makeContext({
        "validate-output": { valid: true, issues: [], resolvedSignals: {} },
      });
      expect(getFn(fns, "guard_validate_done")(ctx, makeEvent())).toBe(true);
    });

    it("returns false when validate-output has valid===false", () => {
      const ctx = makeContext({
        "validate-output": { valid: false, issues: ["bad"], resolvedSignals: {} },
      });
      expect(getFn(fns, "guard_validate_done")(ctx, makeEvent())).toBe(false);
    });

    it("returns false when validate-output is missing", () => {
      const ctx = makeContext();
      expect(getFn(fns, "guard_validate_done")(ctx, makeEvent())).toBe(false);
    });
  });

  describe("prepare_review", () => {
    it("returns config with resolvedSignals from validate-output", () => {
      const resolved = { "my-sig": { provider: "http", config: { path: "/p" } } };
      const ctx = makeContext({
        "validate-output": { valid: true, issues: [], resolvedSignals: resolved },
        "extend-input": { targetWorkspaceId: "ws-1", additions: {} },
      });
      const result = getFn(fns, "prepare_review")(ctx, makeEvent()) as Record<string, unknown>;
      const config = result.config as Record<string, unknown>;
      expect(config.targetWorkspaceId).toBe("ws-1");
      expect(config.resolvedSignals).toEqual(resolved);
      expect(config.platformUrl).toBe("http://localhost:8080");
    });

    it("throws when validate-output is missing", () => {
      const ctx = makeContext({ "extend-input": { targetWorkspaceId: "ws" } });
      expect(() => getFn(fns, "prepare_review")(ctx, makeEvent())).toThrow();
    });
  });

  describe("guard_review_done", () => {
    it("returns true when verdict is APPROVE", () => {
      const ctx = makeContext({ "review-output": { verdict: "APPROVE", summary: "ok" } });
      expect(getFn(fns, "guard_review_done")(ctx, makeEvent())).toBe(true);
    });

    it("returns false when verdict is NEEDS_CHANGES", () => {
      const ctx = makeContext({ "review-output": { verdict: "NEEDS_CHANGES", summary: "issues" } });
      expect(getFn(fns, "guard_review_done")(ctx, makeEvent())).toBe(false);
    });

    it("returns false when verdict is BLOCK", () => {
      const ctx = makeContext({ "review-output": { verdict: "BLOCK", summary: "blocked" } });
      expect(getFn(fns, "guard_review_done")(ctx, makeEvent())).toBe(false);
    });

    it("returns false when review-output is missing", () => {
      const ctx = makeContext();
      expect(getFn(fns, "guard_review_done")(ctx, makeEvent())).toBe(false);
    });
  });

  describe("prepare_apply", () => {
    it("constructs config with targetWorkspaceId and resolvedSignals", () => {
      const resolved = { "sig-a": { provider: "schedule", config: { schedule: "0 16 * * 5" } } };
      const ctx = makeContext({
        "validate-output": { valid: true, issues: [], resolvedSignals: resolved },
        "extend-input": { targetWorkspaceId: "target-ws", additions: {} },
      });
      const result = getFn(fns, "prepare_apply")(ctx, makeEvent()) as Record<string, unknown>;
      const config = result.config as Record<string, unknown>;
      expect(config.targetWorkspaceId).toBe("target-ws");
      expect(config.resolvedSignals).toEqual(resolved);
      expect(config.platformUrl).toBe("http://localhost:8080");
    });

    it("throws when validate-output is missing", () => {
      const ctx = makeContext({ "extend-input": { targetWorkspaceId: "ws" } });
      expect(() => getFn(fns, "prepare_apply")(ctx, makeEvent())).toThrow();
    });
  });

  describe("guard_apply_done", () => {
    it("returns true when apply-output exists", () => {
      const ctx = makeContext({
        "apply-output": { applied: true, created: ["s1"], errors: [], summary: "done" },
      });
      expect(getFn(fns, "guard_apply_done")(ctx, makeEvent())).toBe(true);
    });

    it("returns false when apply-output is missing", () => {
      const ctx = makeContext();
      expect(getFn(fns, "guard_apply_done")(ctx, makeEvent())).toBe(false);
    });
  });
});

describe("ExtendWorkspacePayloadSchema", () => {
  it("accepts valid payload with http signal", () => {
    const payload = {
      targetWorkspaceId: "my-workspace",
      additions: {
        signals: {
          "weekly-report": {
            provider: "http" as const,
            description: "Weekly report trigger",
            config: { path: "/webhooks/weekly-report" },
          },
        },
      },
    };
    const result = ExtendWorkspacePayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("accepts valid payload with schedule signal", () => {
    const payload = {
      targetWorkspaceId: "my-workspace",
      additions: {
        signals: {
          "friday-reminder": {
            provider: "schedule" as const,
            description: "Friday 4pm reminder",
            config: { schedule: "0 16 * * 5", timezone: "America/Los_Angeles" },
          },
        },
      },
    };
    const result = ExtendWorkspacePayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("rejects payload missing targetWorkspaceId", () => {
    const payload = {
      additions: { signals: { s: { provider: "http", description: "d", config: { path: "/p" } } } },
    };
    const result = ExtendWorkspacePayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects payload with empty targetWorkspaceId", () => {
    const payload = {
      targetWorkspaceId: "",
      additions: { signals: { s: { provider: "http", description: "d", config: { path: "/p" } } } },
    };
    const result = ExtendWorkspacePayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects payload with empty signals", () => {
    const payload = { targetWorkspaceId: "ws", additions: { signals: {} } };
    const result = ExtendWorkspacePayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects payload with no signals key", () => {
    const payload = { targetWorkspaceId: "ws", additions: {} };
    const result = ExtendWorkspacePayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

describe("ValidateResultSchema", () => {
  it("accepts valid result with resolved signals", () => {
    const result = ValidateResultSchema.safeParse({
      valid: true,
      issues: [],
      resolvedSignals: {
        "my-signal": {
          provider: "http",
          description: "A signal",
          config: { path: "/webhooks/my-signal" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts invalid result with issues", () => {
    const result = ValidateResultSchema.safeParse({
      valid: false,
      issues: ["Signal 'foo' has unsupported provider 'websocket'"],
      resolvedSignals: {},
    });
    expect(result.success).toBe(true);
  });
});

describe("ApplyResultSchema", () => {
  it("accepts successful apply result", () => {
    const result = ApplyResultSchema.safeParse({
      applied: true,
      created: ["sig-a", "sig-b"],
      errors: [],
      summary: "Created 2 signals",
    });
    expect(result.success).toBe(true);
  });

  it("accepts failed apply result", () => {
    const result = ApplyResultSchema.safeParse({
      applied: false,
      created: [],
      errors: ["sig-a: 409 Conflict — signal already exists"],
      summary: "Failed to create signals",
    });
    expect(result.success).toBe(true);
  });
});

describe("Apply step payload matches CreateSignalInputSchema shape", () => {
  const CreateSignalInputSchema = z.object({
    signalId: z.string().min(1, "Signal ID is required"),
    signal: WorkspaceSignalConfigSchema,
  });

  it("constructs valid POST body for each signal in additions", () => {
    const additions = {
      "weekly-report": {
        provider: "http" as const,
        description: "Weekly report",
        config: { path: "/webhooks/weekly-report" },
      },
      "daily-check": {
        provider: "schedule" as const,
        description: "Daily check",
        config: { schedule: "0 9 * * *", timezone: "UTC" },
      },
    };

    for (const [signalId, signal] of Object.entries(additions)) {
      const body = { signalId, signal };
      const result = CreateSignalInputSchema.safeParse(body);
      if (!result.success) {
        throw new Error(
          `CreateSignalInputSchema parse failed for '${signalId}':\n${JSON.stringify(result.error.issues, null, 2)}`,
        );
      }
      expect(result.success).toBe(true);
    }
  });
});
