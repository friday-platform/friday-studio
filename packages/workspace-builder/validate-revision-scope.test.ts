import { describe, expect, it } from "vitest";
import type {
  ClassifiedDAGStep,
  CredentialBinding,
  DocumentContract,
  Signal,
  WorkspaceBlueprint,
} from "./types.ts";
import { validateRevisionScope } from "./validate-revision-scope.ts";

// ---------------------------------------------------------------------------
// Test helpers — explicit objects to avoid strictObject spread issues
// ---------------------------------------------------------------------------

type SchemaType = WorkspaceBlueprint["jobs"][0]["documentContracts"][0]["schema"];

function signal(overrides?: Partial<Signal>): Signal {
  return {
    id: "on-schedule",
    name: "On Schedule",
    title: "Runs on schedule",
    signalType: "schedule",
    description: "Triggers every hour",
    ...overrides,
  } as Signal;
}

function step(overrides?: Partial<ClassifiedDAGStep>): ClassifiedDAGStep {
  return {
    id: "step-1",
    agentId: "analyzer",
    description: "Run analysis",
    depends_on: [],
    executionType: "llm",
    executionRef: "analyzer",
    ...overrides,
  } as ClassifiedDAGStep;
}

function docContract(overrides?: Partial<DocumentContract>): DocumentContract {
  return {
    producerStepId: "step-1",
    documentId: "analysis-output",
    documentType: "summary",
    schema: { type: "object" } as SchemaType,
    ...overrides,
  } as DocumentContract;
}

function job(overrides?: Record<string, unknown>): WorkspaceBlueprint["jobs"][0] {
  const base = {
    id: "analyze-job",
    name: "Analyze Job",
    title: "Analyze",
    triggerSignalId: "on-schedule",
    steps: [step()],
    documentContracts: [docContract()],
    prepareMappings: [],
  };
  return { ...base, ...overrides } as WorkspaceBlueprint["jobs"][0];
}

function makeBlueprint(overrides?: Partial<WorkspaceBlueprint>): WorkspaceBlueprint {
  return {
    workspace: { name: "test-workspace", purpose: "Test purpose" },
    signals: [signal()],
    agents: [
      {
        id: "analyzer",
        name: "Analyzer",
        description: "Analyzes data",
        capabilities: ["analysis"],
      },
    ],
    jobs: [job()],
    ...overrides,
  } as WorkspaceBlueprint;
}

describe("validateRevisionScope", () => {
  it("accepts identical blueprints", () => {
    const bp = makeBlueprint();
    const result = validateRevisionScope(bp, bp);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("accepts changes to tunable fields only", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({
      workspace: { name: "test-workspace", purpose: "Updated purpose with more detail" },
      signals: [
        signal({ title: "Updated title", description: "Updated desc", displayLabel: "New" }),
      ],
      agents: [
        {
          id: "analyzer",
          name: "Analyzer",
          description: "Updated description",
          capabilities: ["analysis", "reporting"],
        },
      ],
      jobs: [
        job({
          title: "Updated Title",
          steps: [step({ description: "Updated step description", tools: ["search-tool"] })],
          documentContracts: [
            docContract({
              schema: { type: "object", properties: { result: { type: "string" } } } as SchemaType,
            }),
          ],
        }),
      ],
    });

    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Signal violations
  // -------------------------------------------------------------------------

  it("rejects added signal", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({
      signals: [signal(), signal({ id: "new-signal", name: "New", signalType: "http" })],
    });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining('signal "new-signal" added'));
  });

  it("rejects removed signal", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({ signals: [] });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.stringContaining('signal "on-schedule" removed'),
    );
  });

  it("rejects changed signal type", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({ signals: [signal({ signalType: "http" })] });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining("signalType changed"));
  });

  // -------------------------------------------------------------------------
  // Agent violations
  // -------------------------------------------------------------------------

  it("rejects added agent", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({
      agents: [
        { id: "analyzer", name: "Analyzer", description: "d", capabilities: [] },
        { id: "new-agent", name: "New", description: "Added", capabilities: [] },
      ],
    });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining('agent "new-agent" added'));
  });

  it("rejects removed agent", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({ agents: [] });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining('agent "analyzer" removed'));
  });

  it("rejects changed agent bundledId", () => {
    const original = makeBlueprint({
      agents: [
        {
          id: "analyzer",
          name: "Analyzer",
          description: "d",
          capabilities: [],
          bundledId: "research",
        },
      ],
    });
    const revised = makeBlueprint({
      agents: [
        {
          id: "analyzer",
          name: "Analyzer",
          description: "d",
          capabilities: [],
          bundledId: "email",
        },
      ],
    });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining("bundledId changed"));
  });

  // -------------------------------------------------------------------------
  // Job violations
  // -------------------------------------------------------------------------

  it("rejects added job", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({
      jobs: [
        job(),
        job({ id: "new-job", name: "New Job", title: "New", steps: [], documentContracts: [] }),
      ],
    });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining('job "new-job" added'));
  });

  it("rejects removed job", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({ jobs: [] });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining('job "analyze-job" removed'));
  });

  it("rejects changed triggerSignalId", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({ jobs: [job({ triggerSignalId: "different-signal" })] });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining("triggerSignalId changed"));
  });

  // -------------------------------------------------------------------------
  // Step violations
  // -------------------------------------------------------------------------

  it("rejects added step", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({
      jobs: [job({ steps: [step(), step({ id: "step-2", depends_on: ["step-1"] })] })],
    });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining('step "step-2" added'));
  });

  it("rejects changed depends_on edges", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({
      jobs: [job({ steps: [step({ depends_on: ["some-other-step"] })] })],
    });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining("depends_on changed"));
  });

  it("rejects changed executionType", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({ jobs: [job({ steps: [step({ executionType: "bundled" })] })] });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining("executionType changed"));
  });

  // -------------------------------------------------------------------------
  // Document contract violations
  // -------------------------------------------------------------------------

  it("rejects removed document contract", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({ jobs: [job({ documentContracts: [] })] });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining("documentContract"));
    expect(result.violations).toContainEqual(expect.stringContaining("removed"));
  });

  it("accepts changed document contract schema", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({
      jobs: [
        job({
          documentContracts: [
            docContract({
              schema: {
                type: "object",
                properties: { newField: { type: "string" } },
              } as SchemaType,
            }),
          ],
        }),
      ],
    });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Conditional violations
  // -------------------------------------------------------------------------

  it("rejects changed conditional branches", () => {
    const conditionals = [
      {
        stepId: "step-1",
        field: "output.type",
        branches: [
          { equals: "a", targetStep: "step-2" },
          { default: true, targetStep: "step-3" },
        ],
      },
    ];
    const original = makeBlueprint({ jobs: [job({ conditionals })] });
    const revised = makeBlueprint({
      jobs: [
        job({
          conditionals: [
            {
              stepId: "step-1",
              field: "output.type",
              branches: [{ equals: "b", targetStep: "step-4" }],
            },
          ],
        }),
      ],
    });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining("branches changed"));
  });

  // -------------------------------------------------------------------------
  // Credential binding violations
  // -------------------------------------------------------------------------

  it("rejects added credential binding", () => {
    const original = makeBlueprint();
    const binding: CredentialBinding = {
      targetType: "mcp",
      targetId: "slack-server",
      field: "SLACK_TOKEN",
      credentialId: "cred-123",
      provider: "slack",
      key: "access_token",
    };
    const revised = makeBlueprint({ credentialBindings: [binding] });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining("credentialBinding"));
    expect(result.violations).toContainEqual(expect.stringContaining("added"));
  });

  // -------------------------------------------------------------------------
  // Workspace name
  // -------------------------------------------------------------------------

  it("rejects changed workspace name", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({ workspace: { name: "different-name", purpose: "same" } });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining("workspace.name changed"));
  });

  // -------------------------------------------------------------------------
  // Multiple violations
  // -------------------------------------------------------------------------

  it("collects multiple violations", () => {
    const original = makeBlueprint();
    const revised = makeBlueprint({
      workspace: { name: "changed", purpose: "changed" },
      signals: [],
      agents: [],
      jobs: [],
    });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });

  // -------------------------------------------------------------------------
  // Prepare mapping tunable fields
  // -------------------------------------------------------------------------

  it("accepts changed prepare mapping sources and constants", () => {
    const original = makeBlueprint({
      jobs: [
        job({
          prepareMappings: [
            {
              consumerStepId: "step-1",
              documentId: "input-doc",
              documentType: "data",
              sources: [{ from: "field.a", to: "inputA" }],
              constants: [{ key: "mode", value: "fast" }],
            },
          ],
        }),
      ],
    });
    const revised = makeBlueprint({
      jobs: [
        job({
          prepareMappings: [
            {
              consumerStepId: "step-1",
              documentId: "input-doc",
              documentType: "data",
              sources: [
                {
                  from: "field.b",
                  to: "inputB",
                  transform: "value.toUpperCase()",
                  description: "uppercase",
                },
              ],
              constants: [
                { key: "mode", value: "thorough" },
                { key: "extra", value: true },
              ],
            },
          ],
        }),
      ],
    });
    const result = validateRevisionScope(original, revised);
    expect(result.ok).toBe(true);
  });
});
