import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WorkspaceConfigSchema } from "@atlas/config";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { parse } from "@std/yaml";
import { describe, expect, it } from "vitest";
import { buildFSMFromPlan } from "../compiler/build-fsm.ts";
import type { CredentialBinding, SignalConfig, WorkspaceBlueprint } from "../types.ts";
import { WorkspaceBlueprintSchema } from "../types.ts";
import { buildWorkspaceYaml, type Phase1Output } from "./build-workspace.ts";

function loadFixtureData(fixtureName: string) {
  const dir = import.meta.dirname;
  if (!dir) throw new Error("import.meta.dirname unavailable");
  const fixturePath = resolve(dir, "../fixtures", `${fixtureName}.json`);
  const phase3 = WorkspaceBlueprintSchema.parse(JSON.parse(readFileSync(fixturePath, "utf-8")));
  const firstJob = phase3.jobs[0];
  if (!firstJob) throw new Error(`No jobs found in fixture ${fixtureName}`);
  const compiled = buildFSMFromPlan(firstJob);
  if (!compiled.success) throw new Error(`Failed to compile FSM from ${fixtureName}`);
  const fsms = [compiled.value.fsm];
  const phase1: Phase1Output = {
    workspace: phase3.workspace,
    signals: phase3.signals,
    agents: phase3.agents,
  };
  return { phase1, phase3, fsms };
}

/** Builds workspace YAML and validates it through the production schema. */
function buildAndParse(...args: Parameters<typeof buildWorkspaceYaml>) {
  return WorkspaceConfigSchema.parse(parse(buildWorkspaceYaml(...args)));
}

describe("buildWorkspaceYaml — schedule signal with bundled agents", () => {
  const { phase1: basePhase1, phase3, fsms } = loadFixtureData("email-inbox-summary");
  const signalId = basePhase1.signals[0]?.id;
  if (!signalId) throw new Error("Fixture must have at least one signal");

  const phase1: Phase1Output = {
    ...basePhase1,
    signals: basePhase1.signals.map((s) => ({
      ...s,
      signalConfig: {
        provider: "schedule",
        config: { schedule: "0 9 * * *", timezone: "America/Denver" },
      } satisfies SignalConfig,
    })),
    agents: basePhase1.agents.map((a) => ({ ...a, bundledId: a.id })),
  };

  it("maps schedule signal with correct provider and config", () => {
    const config = buildAndParse(phase1, phase3, fsms);

    expect(config.signals).toMatchObject({
      [signalId]: {
        provider: "schedule",
        config: { schedule: "0 9 * * *", timezone: "America/Denver" },
      },
    });
  });

  it("maps bundled agents as type: atlas", () => {
    const config = buildAndParse(phase1, phase3, fsms);

    for (const agent of phase1.agents) {
      expect(config.agents).toMatchObject({
        [agent.id]: { type: "atlas", agent: agent.bundledId },
      });
    }
  });

  it("includes job trigger signal and FSM inline", () => {
    const config = buildAndParse(phase1, phase3, fsms);
    const firstJob = phase3.jobs[0];
    expect.assert(firstJob != null);

    expect(config.jobs).toMatchObject({
      [firstJob.id]: {
        triggers: [{ signal: firstJob.triggerSignalId }],
        fsm: expect.objectContaining({ id: firstJob.id, states: expect.anything() }),
      },
    });
  });
});

describe("buildWorkspaceYaml — HTTP signal with mixed agent types", () => {
  const { phase1: basePhase1, phase3, fsms } = loadFixtureData("csv-analysis-plan");
  const signalId = basePhase1.signals[0]?.id;
  if (!signalId) throw new Error("Fixture must have at least one signal");

  const phase1: Phase1Output = {
    ...basePhase1,
    signals: basePhase1.signals.map((s) => ({
      ...s,
      signalConfig: {
        provider: "http",
        config: { path: `/webhooks/${s.id}` },
      } satisfies SignalConfig,
    })),
    agents: basePhase1.agents.map(({ bundledId: _, ...rest }, i) =>
      i === 0 ? rest : { ...rest, bundledId: rest.id },
    ),
  };

  it("maps HTTP signal with path config", () => {
    const config = buildAndParse(phase1, phase3, fsms);

    expect(config.signals).toMatchObject({
      [signalId]: { provider: "http", config: { path: expect.any(String) } },
    });
  });

  it("maps LLM agents as type: llm, bundled agents as type: atlas", () => {
    const config = buildAndParse(phase1, phase3, fsms);
    const llmAgent = phase1.agents.find((a) => !a.bundledId);
    const bundledAgent = phase1.agents.find((a) => a.bundledId);
    expect.assert(llmAgent != null);
    expect.assert(bundledAgent != null);

    expect(config.agents).toMatchObject({
      [llmAgent.id]: {
        type: "llm",
        config: {
          provider: expect.any(String),
          model: expect.any(String),
          prompt: expect.any(String),
        },
      },
      [bundledAgent.id]: { type: "atlas", agent: bundledAgent.bundledId },
    });
  });

  it("includes payloadSchema in HTTP signal", () => {
    const config = buildAndParse(phase1, phase3, fsms);

    expect(config.signals).toMatchObject({
      [signalId]: { schema: expect.objectContaining({ type: "object" }) },
    });
  });
});

describe("buildWorkspaceYaml — agents with MCP servers", () => {
  const { phase1: basePhase1, phase3, fsms } = loadFixtureData("email-inbox-summary");

  const scheduleSignalConfig = {
    provider: "schedule",
    config: { schedule: "0 9 * * *", timezone: "America/Denver" },
  } satisfies SignalConfig;

  const phase1: Phase1Output = {
    ...basePhase1,
    signals: basePhase1.signals.map((s) => ({ ...s, signalConfig: scheduleSignalConfig })),
    agents: basePhase1.agents.map((a) => {
      if (a.id === "email") {
        return { ...a, mcpServers: [{ serverId: "google-gmail", name: "Gmail" }] };
      }
      return { ...a, bundledId: a.id };
    }),
  };

  it("includes tools.mcp.servers for MCP-backed agents", () => {
    const config = buildAndParse(phase1, phase3, fsms);

    expect(config.tools).toMatchObject({
      mcp: { servers: { "google-gmail": { transport: expect.anything() } } },
    });
  });

  it("renders MCP-backed agent as type: llm with tools wired", () => {
    const config = buildAndParse(phase1, phase3, fsms);

    expect(config.agents).toMatchObject({
      email: { type: "llm", config: { provider: "anthropic", tools: ["google-gmail"] } },
    });
  });

  it("omits tools section when no agents have mcpServers", () => {
    const noMcpPhase1: Phase1Output = {
      ...basePhase1,
      signals: basePhase1.signals.map((s) => ({ ...s, signalConfig: scheduleSignalConfig })),
      agents: basePhase1.agents.map((a) => ({ ...a, bundledId: a.id })),
    };
    const config = buildAndParse(noMcpPhase1, phase3, fsms);

    expect(config.tools).toBeUndefined();
  });
});

describe("buildWorkspaceYaml — error handling", () => {
  it("throws when signal is missing signalConfig", () => {
    const phase1: Phase1Output = {
      workspace: { name: "Test", purpose: "Test" },
      signals: [
        {
          id: "test-signal",
          name: "Test",
          title: "Test",
          signalType: "http",
          description: "Test signal",
        },
      ],
      agents: [],
    };
    const phase3: WorkspaceBlueprint = {
      workspace: { name: "Test", purpose: "Test" },
      signals: [],
      agents: [],
      jobs: [],
    };

    expect(() => buildWorkspaceYaml(phase1, phase3, [])).toThrow("missing signalConfig");
  });

  it("throws when FSM definition is missing for a job", () => {
    const phase1: Phase1Output = {
      workspace: { name: "Test", purpose: "Test" },
      signals: [],
      agents: [],
    };
    const phase3: WorkspaceBlueprint = {
      workspace: { name: "Test", purpose: "Test" },
      signals: [],
      agents: [],
      jobs: [
        {
          id: "missing-fsm-job",
          name: "Missing FSM",
          title: "Missing",
          triggerSignalId: "test",
          steps: [],
          documentContracts: [],
          prepareMappings: [],
        },
      ],
    };

    expect(() => buildWorkspaceYaml(phase1, phase3, [])).toThrow(
      'No FSM definition found for job "missing-fsm-job"',
    );
  });
});

function makeBinding(
  overrides: Partial<CredentialBinding> &
    Pick<CredentialBinding, "targetType" | "targetId" | "field">,
): CredentialBinding {
  return {
    credentialId: `cred_${overrides.field.toLowerCase()}`,
    provider: overrides.targetId,
    key: "access_token",
    ...overrides,
  };
}

describe("buildWorkspaceYaml — credential bindings", () => {
  const { phase1: basePhase1, phase3, fsms } = loadFixtureData("email-inbox-summary");

  const scheduleSignalConfig = {
    provider: "schedule",
    config: { schedule: "0 9 * * *", timezone: "America/Denver" },
  } satisfies SignalConfig;

  const phase1WithMcp: Phase1Output = {
    ...basePhase1,
    signals: basePhase1.signals.map((s) => ({ ...s, signalConfig: scheduleSignalConfig })),
    agents: basePhase1.agents.map((a) => {
      if (a.id === "email") {
        return { ...a, mcpServers: [{ serverId: "google-gmail", name: "Gmail" }] };
      }
      return { ...a, bundledId: a.id };
    }),
  };

  const phase1WithBundled: Phase1Output = {
    ...basePhase1,
    signals: basePhase1.signals.map((s) => ({ ...s, signalConfig: scheduleSignalConfig })),
    agents: basePhase1.agents.map((a) => ({ ...a, bundledId: a.id })),
  };

  it("produces identical output when bindings is undefined vs empty array", () => {
    const withoutBindings = buildWorkspaceYaml(phase1WithMcp, phase3, fsms);
    const withEmptyBindings = buildWorkspaceYaml(phase1WithMcp, phase3, fsms, []);
    expect(withoutBindings).toBe(withEmptyBindings);
  });

  it("replaces MCP server env with resolved Link credential ref", () => {
    const bindings: CredentialBinding[] = [
      makeBinding({
        targetType: "mcp",
        targetId: "google-gmail",
        field: "GOOGLE_GMAIL_ACCESS_TOKEN",
        credentialId: "cred_gmail_123",
        provider: "google-gmail",
        key: "access_token",
      }),
    ];
    const config = buildAndParse(phase1WithMcp, phase3, fsms, bindings);

    expect(config.tools).toMatchObject({
      mcp: {
        servers: {
          "google-gmail": {
            env: {
              GOOGLE_GMAIL_ACCESS_TOKEN: {
                from: "link",
                id: "cred_gmail_123",
                provider: "google-gmail",
                key: "access_token",
              },
            },
          },
        },
      },
    });
  });

  it("adds env block to bundled agent with resolved credential", () => {
    const bindings: CredentialBinding[] = [
      makeBinding({
        targetType: "agent",
        targetId: "email",
        field: "SENDGRID_API_KEY",
        credentialId: "cred_sg_456",
        provider: "sendgrid",
        key: "api_key",
      }),
    ];
    const config = buildAndParse(phase1WithBundled, phase3, fsms, bindings);

    expect(config.agents).toMatchObject({
      email: {
        env: {
          SENDGRID_API_KEY: {
            from: "link",
            id: "cred_sg_456",
            provider: "sendgrid",
            key: "api_key",
          },
        },
      },
    });
  });

  it("applies multiple credential bindings to the same MCP server", () => {
    const bindings: CredentialBinding[] = [
      makeBinding({
        targetType: "mcp",
        targetId: "google-gmail",
        field: "GOOGLE_GMAIL_ACCESS_TOKEN",
        credentialId: "cred_gmail_tok",
        key: "access_token",
      }),
      makeBinding({
        targetType: "mcp",
        targetId: "google-gmail",
        field: "GOOGLE_GMAIL_REFRESH_TOKEN",
        credentialId: "cred_gmail_ref",
        key: "refresh_token",
      }),
    ];
    const config = buildAndParse(phase1WithMcp, phase3, fsms, bindings);

    expect(config.tools).toMatchObject({
      mcp: {
        servers: {
          "google-gmail": {
            env: {
              GOOGLE_GMAIL_ACCESS_TOKEN: {
                from: "link",
                id: "cred_gmail_tok",
                provider: "google-gmail",
                key: "access_token",
              },
              GOOGLE_GMAIL_REFRESH_TOKEN: {
                from: "link",
                id: "cred_gmail_ref",
                provider: "google-gmail",
                key: "refresh_token",
              },
            },
          },
        },
      },
    });
  });

  it("silently ignores binding for non-existent MCP server", () => {
    const bindings: CredentialBinding[] = [
      makeBinding({
        targetType: "mcp",
        targetId: "non-existent-server",
        field: "TOKEN",
        credentialId: "cred_nope",
      }),
    ];
    expect(() => buildAndParse(phase1WithMcp, phase3, fsms, bindings)).not.toThrow();
  });

  it("silently ignores binding for non-existent agent", () => {
    const bindings: CredentialBinding[] = [
      makeBinding({
        targetType: "agent",
        targetId: "no-such-agent",
        field: "TOKEN",
        credentialId: "cred_nope",
      }),
    ];
    expect(() => buildAndParse(phase1WithBundled, phase3, fsms, bindings)).not.toThrow();
  });
});

describe("buildWorkspaceYaml — dynamic MCP servers", () => {
  const { phase1: basePhase1, phase3, fsms } = loadFixtureData("email-inbox-summary");

  const firstAgent = basePhase1.agents[0];
  if (!firstAgent) throw new Error("fixture missing agents");

  const scheduleSignalConfig = {
    provider: "schedule",
    config: { schedule: "0 9 * * *", timezone: "America/Denver" },
  } satisfies SignalConfig;

  const dynamicServer: MCPServerMetadata = {
    id: "custom-crm",
    name: "Custom CRM",
    securityRating: "unverified",
    source: "web",
    configTemplate: {
      transport: { type: "stdio", command: "npx", args: ["-y", "custom-crm-mcp"] },
      env: { CRM_KEY: "placeholder" },
    },
  };

  const phase1WithDynamic: Phase1Output = {
    ...basePhase1,
    signals: basePhase1.signals.map((s) => ({ ...s, signalConfig: scheduleSignalConfig })),
    agents: [
      { ...firstAgent, mcpServers: [{ serverId: "custom-crm", name: "Custom CRM" }] },
      ...basePhase1.agents.slice(1).map((a) => ({ ...a, bundledId: a.id })),
    ],
  };

  it("resolves dynamic MCP server config instead of throwing", () => {
    const config = buildAndParse(phase1WithDynamic, phase3, fsms, undefined, [dynamicServer]);

    expect(config.tools).toMatchObject({
      mcp: {
        servers: {
          "custom-crm": {
            transport: { type: "stdio", command: "npx", args: ["-y", "custom-crm-mcp"] },
          },
        },
      },
    });
  });

  it("prefers static registry over dynamic server with same ID", () => {
    const dynamicGmail: MCPServerMetadata = {
      id: "google-gmail",
      name: "Dynamic Gmail",
      securityRating: "unverified",
      source: "web",
      configTemplate: {
        transport: { type: "stdio", command: "npx", args: ["-y", "dynamic-gmail-mcp"] },
      },
    };

    const phase1WithGmail: Phase1Output = {
      ...basePhase1,
      signals: basePhase1.signals.map((s) => ({ ...s, signalConfig: scheduleSignalConfig })),
      agents: [
        { ...firstAgent, mcpServers: [{ serverId: "google-gmail", name: "Gmail" }] },
        ...basePhase1.agents.slice(1).map((a) => ({ ...a, bundledId: a.id })),
      ],
    };

    // Should use the static registry config (which has transport), not the dynamic one
    const config = buildAndParse(phase1WithGmail, phase3, fsms, undefined, [dynamicGmail]);

    expect(config.tools).toMatchObject({
      mcp: { servers: { "google-gmail": { transport: expect.anything() } } },
    });
  });

  it("applies credential bindings to dynamic MCP server", () => {
    const bindings: CredentialBinding[] = [
      makeBinding({
        targetType: "mcp",
        targetId: "custom-crm",
        field: "CRM_KEY",
        credentialId: "cred_crm_123",
        key: "api_key",
      }),
    ];
    const config = buildAndParse(phase1WithDynamic, phase3, fsms, bindings, [dynamicServer]);

    expect(config.tools).toMatchObject({
      mcp: {
        servers: {
          "custom-crm": {
            env: {
              CRM_KEY: { from: "link", id: "cred_crm_123", provider: "custom-crm", key: "api_key" },
            },
          },
        },
      },
    });
  });

  it("throws when server ID not in static or dynamic registry", () => {
    const phase1WithUnknown: Phase1Output = {
      ...basePhase1,
      signals: basePhase1.signals.map((s) => ({ ...s, signalConfig: scheduleSignalConfig })),
      agents: [
        { ...firstAgent, mcpServers: [{ serverId: "totally-unknown", name: "Unknown" }] },
        ...basePhase1.agents.slice(1).map((a) => ({ ...a, bundledId: a.id })),
      ],
    };

    expect(() =>
      buildWorkspaceYaml(phase1WithUnknown, phase3, fsms, undefined, [dynamicServer]),
    ).toThrow('MCP server "totally-unknown" not found in registry');
  });
});
