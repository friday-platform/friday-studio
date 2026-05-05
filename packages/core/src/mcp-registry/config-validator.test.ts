import type { WorkspaceConfig } from "@atlas/config";
import { describe, expect, it } from "vitest";
import {
  type PackageResolver,
  type ValidationContext,
  validateWorkspaceConfig,
} from "./config-validator.ts";

/**
 * Builds a ValidationContext with sensible pass-through defaults that
 * individual tests can override. Keeps test setup short enough that each
 * assertion is readable on its own.
 */
function makeCtx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    resolvers: overrides.resolvers ?? [],
    skillDb: overrides.skillDb ?? { has: () => Promise.resolve(true) },
    modelCatalog: overrides.modelCatalog ?? { has: () => true },
    workspaceList: overrides.workspaceList ?? { has: () => Promise.resolve(true) },
  };
}

/**
 * Tiny helper: build a minimal WorkspaceConfig with the given overrides
 * merged into the structure. Typed as `WorkspaceConfig` via `as` because
 * the full schema is stricter than most tests need.
 */
function makeConfig(parts: Partial<WorkspaceConfig>): WorkspaceConfig {
  return { version: "1.0", workspace: { name: "test-ws" }, ...parts } as WorkspaceConfig;
}

/**
 * A minimal PackageResolver that always reports `not_found` for one
 * specific ref. Useful for the "hallucinated package" regression tests.
 */
function stubResolver(
  command: string,
  mapping: Record<string, "ok" | "not_found" | "unreachable" | "auth_required">,
): PackageResolver {
  return {
    matches(cmd, args) {
      if (cmd !== command) return null;
      const ref = args.filter((a) => !a.startsWith("-"))[0];
      return ref ? { ref } : null;
    },
    check: (ref) => {
      const outcome = mapping[ref];
      if (outcome === "ok") return Promise.resolve({ ok: true });
      if (!outcome) return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: false, reason: outcome });
    },
  };
}

describe("validateWorkspaceConfig", () => {
  it("reports OK for an empty config", async () => {
    const report = await validateWorkspaceConfig(makeConfig({}), makeCtx());
    expect(report).toEqual({ status: "ok", issues: [] });
  });

  it("catches a hallucinated npm package — the primary bug this whole thing exists for", async () => {
    // Regression: @joshuarileydev/sqlite-mcp-server does not exist on npm;
    // workspace was accepted and only failed at runtime MCP spawn.
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            sqlite: {
              transport: {
                type: "stdio",
                command: "npx",
                args: ["-y", "@joshuarileydev/sqlite-mcp-server"],
              },
            },
          },
        },
      },
    } as never);
    const resolvers = [stubResolver("npx", { "@joshuarileydev/sqlite-mcp-server": "not_found" })];
    const report = await validateWorkspaceConfig(config, makeCtx({ resolvers }));
    expect(report.status).toBe("hard_fail");
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      severity: "error",
      code: "npm_package_not_found",
      path: "tools.mcp.servers.sqlite.transport.args",
      value: "@joshuarileydev/sqlite-mcp-server",
    });
  });

  it("degrades to warn when the registry is unreachable", async () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            sqlite: { transport: { type: "stdio", command: "npx", args: ["-y", "anything"] } },
          },
        },
      },
    } as never);
    const resolvers = [stubResolver("npx", { anything: "unreachable" })];
    const report = await validateWorkspaceConfig(config, makeCtx({ resolvers }));
    expect(report.status).toBe("warn");
    expect(report.issues[0]?.severity).toBe("warning");
    expect(report.issues[0]?.code).toBe("registry_unreachable");
  });

  it("degrades to warn on 401/403 (likely private package)", async () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            private: { transport: { type: "stdio", command: "npx", args: ["-y", "@corp/mcp"] } },
          },
        },
      },
    } as never);
    const resolvers = [stubResolver("npx", { "@corp/mcp": "auth_required" })];
    const report = await validateWorkspaceConfig(config, makeCtx({ resolvers }));
    expect(report.status).toBe("warn");
    expect(report.issues[0]?.code).toBe("registry_auth_required");
  });

  it("skips resolver check entirely when skipResolverCheck is set", async () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            sqlite: {
              skipResolverCheck: true,
              transport: {
                type: "stdio",
                command: "npx",
                args: ["-y", "@joshuarileydev/sqlite-mcp-server"],
              },
            },
          },
        },
      },
    } as never);
    const resolvers = [stubResolver("npx", { "@joshuarileydev/sqlite-mcp-server": "not_found" })];
    const report = await validateWorkspaceConfig(config, makeCtx({ resolvers }));
    expect(report.status).toBe("ok");
  });

  it("skips resolver check for blessed MCP servers (fast path)", async () => {
    // `time` is a blessed stdio entry in registry-consolidated.ts. Even if a
    // misconfigured resolver would report 404 for `mcp-server-time`, the
    // blessed-registry short-circuit must prevent the network call entirely.
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            time: { transport: { type: "stdio", command: "uvx", args: ["mcp-server-time"] } },
          },
        },
      },
    } as never);
    const resolvers = [stubResolver("uvx", { "mcp-server-time": "not_found" })];
    const report = await validateWorkspaceConfig(config, makeCtx({ resolvers }));
    expect(report.status).toBe("ok");
  });

  it("catches a typo'd agent reference in execution.agents", async () => {
    // Near-miss case: `writter` (typo) → `writer` (defined).
    const config = makeConfig({
      agents: { writer: { type: "llm", config: {} } },
      signals: { save: { provider: "http", config: { path: "/hook" } } },
      jobs: {
        save_entry: {
          triggers: [{ signal: "save" }],
          execution: { strategy: "sequential", agents: ["writter"] },
        },
      },
    } as never);
    const report = await validateWorkspaceConfig(config, makeCtx());
    expect(report.status).toBe("hard_fail");
    const issue = report.issues.find((i) => i.code === "unknown_agent_id");
    expect(issue?.path).toBe("jobs.save_entry.execution.agents[0]");
    expect(issue?.value).toBe("writter");
    expect(issue?.suggest).toContain("writer");
  });

  it("catches a renamed agent (no typo) without suggesting a noise match", async () => {
    // Complement: `scribe` vs `writer` isn't a typo — edit distance too far.
    // We should still hard-fail on the missing reference but not surface a
    // misleading "did you mean writer?" suggestion.
    const config = makeConfig({
      agents: { writer: { type: "llm", config: {} } },
      signals: { save: { provider: "http", config: { path: "/hook" } } },
      jobs: {
        save_entry: {
          triggers: [{ signal: "save" }],
          execution: { strategy: "sequential", agents: ["scribe"] },
        },
      },
    } as never);
    const report = await validateWorkspaceConfig(config, makeCtx());
    expect(report.status).toBe("hard_fail");
    const issue = report.issues.find((i) => i.code === "unknown_agent_id");
    expect(issue?.value).toBe("scribe");
    // Suggest list may exist but must not claim `writer` — edit distance
    // between "scribe" and "writer" exceeds the near-miss threshold.
    expect(issue?.suggest ?? []).not.toContain("writer");
  });

  it("catches a typo'd signal in job triggers", async () => {
    const config = makeConfig({
      signals: { save: { provider: "http", config: { path: "/hook" } } },
      jobs: {
        save_entry: {
          triggers: [{ signal: "sav" }],
          execution: { strategy: "sequential", agents: [] },
        },
      },
    } as never);
    const report = await validateWorkspaceConfig(config, makeCtx());
    const issue = report.issues.find((i) => i.code === "unknown_signal_name");
    expect(issue?.path).toBe("jobs.save_entry.triggers[0].signal");
    expect(issue?.suggest).toContain("save");
  });

  it("catches a structurally-malformed FSM — Friday's common hallucination", async () => {
    // Regression: end-to-end QA of a knowledge-base workspace. Friday authored a workspace with
    // FSM states like `{type: "action", action: {...}, next: "done"}` —
    // plausible-looking but not the real schema. Workspace imported fine,
    // lint said ok, and the first signal dispatch 500'd with a Zod error
    // buried deep in the daemon response. This pass surfaces it at create
    // time so the LLM gets structured feedback to patch.
    const config = makeConfig({
      agents: { "save-agent": { type: "llm", config: {} } },
      signals: { "save-entry": { provider: "http", config: { path: "/save" } } },
      jobs: {
        "save-entry": {
          triggers: [{ signal: "save-entry" }],
          fsm: {
            initial: "step_save",
            states: {
              step_save: {
                type: "action",
                action: { type: "llm", agent: "save-agent" },
                next: "done",
              },
              done: { type: "final" },
            },
          },
        },
      },
    } as never);
    const report = await validateWorkspaceConfig(config, makeCtx());
    expect(report.status).toBe("hard_fail");
    const issues = report.issues.filter((i) => i.code === "fsm_structural_error");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.message).toContain("entry");
  });

  it("catches an unknown FSM agent reference", async () => {
    const config = makeConfig({
      agents: { writer: { type: "llm", config: {} } },
      signals: { save: { provider: "http", config: { path: "/hook" } } },
      jobs: {
        save_entry: {
          triggers: [{ signal: "save" }],
          fsm: {
            id: "save-pipeline",
            initial: "idle",
            states: {
              idle: { on: { save: { target: "working" } } },
              working: { entry: [{ type: "agent", agentId: "nonexistent-agent" }] },
            },
          },
        },
      },
    } as never);
    const report = await validateWorkspaceConfig(config, makeCtx());
    const issue = report.issues.find(
      (i) => i.code === "unknown_agent_id" && i.value === "nonexistent-agent",
    );
    expect(issue).toBeDefined();
    expect(issue?.path).toContain("save_entry");
  });

  it("catches an unknown memory store in outputs.memory", async () => {
    const config = makeConfig({
      agents: { writer: { type: "llm", config: {} } },
      signals: { save: { provider: "http", config: { path: "/hook" } } },
      memory: { own: [{ name: "notes", type: "short_term", strategy: "narrative" }] },
      jobs: {
        save_entry: {
          triggers: [{ signal: "save" }],
          execution: { strategy: "sequential", agents: ["writer"] },
          outputs: { memory: "notess", entryKind: "note" },
        },
      },
    } as never);
    const report = await validateWorkspaceConfig(config, makeCtx());
    const issue = report.issues.find((i) => i.code === "unknown_memory_store");
    expect(issue?.value).toBe("notess");
    expect(issue?.suggest).toContain("notes");
  });

  it("catches an unknown skill reference", async () => {
    const config = makeConfig({ skills: [{ name: "@tempest/nonexistent-skill" }] } as never);
    const skillDb = { has: () => Promise.resolve(false) };
    const report = await validateWorkspaceConfig(config, makeCtx({ skillDb }));
    const issue = report.issues.find((i) => i.code === "unknown_skill");
    expect(issue?.value).toBe("@tempest/nonexistent-skill");
  });

  it("passes friday/atlas skill refs through without DB lookup", async () => {
    const config = makeConfig({
      skills: [{ name: "@friday/pr-code-review" }, { name: "@atlas/whatever" }],
    } as never);
    let dbCalls = 0;
    const skillDb = {
      has: () => {
        dbCalls++;
        return Promise.resolve(false);
      },
    };
    const report = await validateWorkspaceConfig(config, makeCtx({ skillDb }));
    expect(dbCalls).toBe(0);
    expect(report.status).toBe("ok");
  });

  it("catches a hallucinated model id", async () => {
    const config = makeConfig({
      agents: {
        writer: { type: "llm", config: { provider: "anthropic", model: "claude-nonexistent-9" } },
      },
    } as never);
    const modelCatalog = {
      has: (provider: string, model: string) =>
        provider === "anthropic" && model === "claude-sonnet-4-6",
    };
    const report = await validateWorkspaceConfig(config, makeCtx({ modelCatalog }));
    const issue = report.issues.find((i) => i.code === "unknown_model");
    expect(issue?.value).toBe("anthropic:claude-nonexistent-9");
  });

  it("catches a memory mount referring to a missing workspace", async () => {
    const config = makeConfig({
      memory: {
        own: [],
        mounts: [
          {
            name: "upstream",
            source: "missing_ws/narrative/notes",
            mode: "ro",
            scope: "workspace",
          },
        ],
      },
    } as never);
    const workspaceList = { has: () => Promise.resolve(false) };
    const report = await validateWorkspaceConfig(config, makeCtx({ workspaceList }));
    const issue = report.issues.find((i) => i.code === "unknown_mount_workspace");
    expect(issue?.value).toBe("missing_ws/narrative/notes");
  });

  it("_global in memory mount source is not validated against the workspace list", async () => {
    const config = makeConfig({
      memory: {
        own: [],
        mounts: [
          { name: "global", source: "_global/narrative/notes", mode: "ro", scope: "workspace" },
        ],
      },
    } as never);
    let calls = 0;
    const workspaceList = {
      has: () => {
        calls++;
        return Promise.resolve(false);
      },
    };
    const report = await validateWorkspaceConfig(config, makeCtx({ workspaceList }));
    expect(calls).toBe(0);
    expect(report.status).toBe("ok");
  });

  it("combines errors and warnings into a single hard_fail when both classes present", async () => {
    // Mix: one hard error (unknown agent) + one warning (unreachable registry).
    const config = makeConfig({
      agents: { writer: { type: "llm", config: {} } },
      signals: { save: { provider: "http", config: { path: "/hook" } } },
      jobs: {
        save_entry: {
          triggers: [{ signal: "save" }],
          execution: { strategy: "sequential", agents: ["unknown"] },
        },
      },
      tools: {
        mcp: {
          servers: { flaky: { transport: { type: "stdio", command: "npx", args: ["-y", "pkg"] } } },
        },
      },
    } as never);
    const resolvers = [stubResolver("npx", { pkg: "unreachable" })];
    const report = await validateWorkspaceConfig(config, makeCtx({ resolvers }));
    expect(report.status).toBe("hard_fail");
    // Hard fail wins, but the warning still surfaces so the LLM sees both.
    expect(report.issues.some((i) => i.severity === "warning")).toBe(true);
    expect(report.issues.some((i) => i.severity === "error")).toBe(true);
  });

  describe("unreachable_agent (chat ↔ jobs contract)", () => {
    // Regression: a workspace where `agents.kb-agent` declared with SQLite
    // tools, but no job wraps it. Chat can't reach agents directly, so the
    // SQLite tools were silently ignored and the "save" fell back to
    // memory_save. The user said "disaster." This rule catches it at
    // create time rather than letting the author ship a broken workspace.
    it("rejects an agent that no FSM or execution invokes", async () => {
      const config = makeConfig({
        agents: {
          "kb-agent": {
            type: "llm",
            config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "..." },
          },
        },
      } as never);
      const report = await validateWorkspaceConfig(config, makeCtx());
      expect(report.status).toBe("hard_fail");
      const issue = report.issues.find((i) => i.code === "unreachable_agent");
      expect(issue?.value).toBe("kb-agent");
      expect(issue?.path).toBe("agents.kb-agent");
    });

    it("accepts an agent invoked by an FSM entry action", async () => {
      const config = makeConfig({
        agents: {
          writer: {
            type: "llm",
            config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "..." },
          },
        },
        signals: { save: { provider: "http", config: { path: "/save" } } },
        jobs: {
          save_entry: {
            triggers: [{ signal: "save" }],
            fsm: {
              id: "save-entry",
              initial: "idle",
              states: {
                idle: { on: { save: { target: "write" } } },
                write: {
                  entry: [
                    {
                      type: "agent",
                      agentId: "writer",
                      outputTo: "r",
                      outputType: "x",
                      prompt: "p",
                    },
                    { type: "emit", event: "DONE" },
                  ],
                  on: { DONE: { target: "done" } },
                },
                done: { type: "final" },
              },
            },
          },
        },
      } as never);
      const report = await validateWorkspaceConfig(config, makeCtx());
      expect(report.issues.find((i) => i.code === "unreachable_agent")).toBeUndefined();
    });

    it("accepts an agent invoked by an execution-style job", async () => {
      const config = makeConfig({
        agents: {
          writer: {
            type: "llm",
            config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "..." },
          },
        },
        signals: { save: { provider: "http", config: { path: "/save" } } },
        jobs: {
          save_entry: {
            triggers: [{ signal: "save" }],
            execution: { strategy: "sequential", agents: ["writer"] },
          },
        },
      } as never);
      const report = await validateWorkspaceConfig(config, makeCtx());
      expect(report.issues.find((i) => i.code === "unreachable_agent")).toBeUndefined();
    });

    it("accepts a workspace with no agents declared at all", async () => {
      // Narrative-memory-only pattern — `memory.own.notes`, no agents, no
      // jobs. This is the correct shape for trivial save-and-recall; the
      // lint must not false-positive here.
      const config = makeConfig({
        memory: { own: [{ name: "notes", type: "long_term", strategy: "narrative" }] },
      } as never);
      const report = await validateWorkspaceConfig(config, makeCtx());
      expect(report.issues.find((i) => i.code === "unreachable_agent")).toBeUndefined();
    });
  });

  describe("unknown_bundled_agent (atlas baseAgentId resolution)", () => {
    // Regression: Yena's "Daily Flash Analysis & Reporting" workspace was
    // built via workspace-chat after the `email` bundled agent was deleted
    // (commit 11667073e). Stale skill content told the meta-agent that
    // `agent: "email"` existed, so the workspace.yml referenced it. Schema
    // validation accepted the freeform string; only at registration time did
    // atlas-daemon log "Base agent not found: email" and silently drop the
    // agent. The FSM step that delegated to it stalled in production.
    //
    // This pass catches the broken reference at create/lint/publish time,
    // before the workspace.yml ever lands in the daemon's load path.
    it("rejects an atlas agent that references a non-existent bundled id", async () => {
      const config = makeConfig({
        agents: {
          "flash-report-email-sender": {
            type: "atlas",
            agent: "email",
            description: "Send the flash report",
            prompt: "Send the report to the team.",
          },
        },
        signals: { tick: { provider: "http", config: { path: "/tick" } } },
        jobs: {
          send: {
            triggers: [{ signal: "tick" }],
            execution: { strategy: "sequential", agents: ["flash-report-email-sender"] },
          },
        },
      } as never);
      const report = await validateWorkspaceConfig(config, makeCtx());
      expect(report.status).toBe("hard_fail");
      const issue = report.issues.find((i) => i.code === "unknown_bundled_agent");
      expect(issue).toBeDefined();
      expect(issue?.path).toBe("agents.flash-report-email-sender.agent");
      expect(issue?.value).toBe("email");
      // Recovery path is shouted at the LLM in the message body.
      expect(issue?.message).toMatch(/list_capabilities/);
    });

    it("accepts a real bundled id (`web`)", async () => {
      const config = makeConfig({
        agents: {
          "news-scout": {
            type: "atlas",
            agent: "web",
            description: "Scrape headlines",
            prompt: "Pull the top 5 headlines.",
          },
        },
        signals: { tick: { provider: "http", config: { path: "/tick" } } },
        jobs: {
          scrape: {
            triggers: [{ signal: "tick" }],
            execution: { strategy: "sequential", agents: ["news-scout"] },
          },
        },
      } as never);
      const report = await validateWorkspaceConfig(config, makeCtx());
      expect(report.issues.find((i) => i.code === "unknown_bundled_agent")).toBeUndefined();
    });

    it("accepts the `browser`/`research` aliases (still in registry)", async () => {
      const config = makeConfig({
        agents: {
          legacy: { type: "atlas", agent: "browser", description: "old workspace", prompt: "..." },
        },
        signals: { tick: { provider: "http", config: { path: "/tick" } } },
        jobs: {
          run: {
            triggers: [{ signal: "tick" }],
            execution: { strategy: "sequential", agents: ["legacy"] },
          },
        },
      } as never);
      const report = await validateWorkspaceConfig(config, makeCtx());
      expect(report.issues.find((i) => i.code === "unknown_bundled_agent")).toBeUndefined();
    });

    it("does not report on type:llm or type:user agents (only atlas)", async () => {
      const config = makeConfig({
        agents: {
          "csv-parser": { type: "user", agent: "csv-parser-not-bundled", prompt: "..." },
          decider: {
            type: "llm",
            description: "decide",
            config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "..." },
          },
        },
        signals: { tick: { provider: "http", config: { path: "/tick" } } },
        jobs: {
          run: {
            triggers: [{ signal: "tick" }],
            execution: { strategy: "sequential", agents: ["csv-parser", "decider"] },
          },
        },
      } as never);
      const report = await validateWorkspaceConfig(config, makeCtx());
      expect(report.issues.find((i) => i.code === "unknown_bundled_agent")).toBeUndefined();
    });

    it("rejects an empty-string agent id (silent-failure shape)", async () => {
      // Zod owns the missing-field case; this pass owns the empty-string
      // case. Without this branch, an empty `agent: ""` would pass the
      // validator, save to disk, and fail at workspace registration with
      // the same `Base agent not found:` symptom this whole pass exists to
      // prevent.
      const config = makeConfig({
        agents: { broken: { type: "atlas", agent: "", description: "broken", prompt: "..." } },
        signals: { tick: { provider: "http", config: { path: "/tick" } } },
        jobs: {
          run: {
            triggers: [{ signal: "tick" }],
            execution: { strategy: "sequential", agents: ["broken"] },
          },
        },
      } as never);
      const report = await validateWorkspaceConfig(config, makeCtx());
      expect(report.status).toBe("hard_fail");
      const issue = report.issues.find((i) => i.code === "unknown_bundled_agent");
      expect(issue?.path).toBe("agents.broken.agent");
      expect(issue?.value).toBe("");
    });

    it("suggests a near-match when the agent id is a typo", async () => {
      const config = makeConfig({
        agents: {
          poster: {
            type: "atlas",
            agent: "slak", // typo of `slack`
            description: "Post to Slack",
            prompt: "Post the standup.",
          },
        },
        signals: { tick: { provider: "http", config: { path: "/tick" } } },
        jobs: {
          post: {
            triggers: [{ signal: "tick" }],
            execution: { strategy: "sequential", agents: ["poster"] },
          },
        },
      } as never);
      const report = await validateWorkspaceConfig(config, makeCtx());
      const issue = report.issues.find((i) => i.code === "unknown_bundled_agent");
      expect(issue?.suggest).toContain("slack");
    });
  });
});
