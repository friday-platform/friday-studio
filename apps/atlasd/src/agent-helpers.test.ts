/**
 * Tests for agent prompt precedence + output validation.
 *
 * These tests verify:
 * 1. action.prompt takes priority over agentConfig.prompt
 * 2. If no action.prompt, falls back to agentConfig.prompt
 * 3. If neither exists, returns context only
 * 4. validateAgentOutput hallucination-detection branching
 */

import type { AgentResult } from "@atlas/agent-sdk";
import type { Context } from "@atlas/fsm-engine";
import {
  ValidationFailedError,
  type ValidationVerdict,
  type VerdictStatus,
} from "@atlas/hallucination";
import type { PlatformModels } from "@atlas/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFinalAgentPrompt,
  extractAgentConfigPrompt,
  validateAgentOutput,
} from "./agent-helpers.ts";

vi.mock("@atlas/fsm-engine", () => ({
  expandArtifactRefsInDocuments: vi.fn((docs: unknown[]) => Promise.resolve(docs)),
}));

const mockValidate = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<ValidationVerdict>>());

vi.mock("@atlas/hallucination", async () => {
  const actual =
    await vi.importActual<typeof import("@atlas/hallucination")>("@atlas/hallucination");
  return { ...actual, validate: mockValidate };
});

describe("extractAgentConfigPrompt", () => {
  it("returns empty string for undefined config", () => {
    expect(extractAgentConfigPrompt(undefined)).toBe("");
  });

  describe("LLM agent", () => {
    it("extracts prompt from LLM agent config", () => {
      // LLMAgentConfig requires config.prompt per schema
      // temperature has a default of 0.3 in schema, so output type requires it
      const config = {
        type: "llm" as const,
        description: "Test agent",
        config: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          prompt: "LLM system prompt",
          temperature: 0.3, // Required in output type (has default)
        },
      };
      expect(extractAgentConfigPrompt(config)).toBe("LLM system prompt");
    });

    // Note: LLMAgentConfig.config.prompt is REQUIRED in schema
    // No test for "without prompt" - that's an invalid config state
  });

  describe("Atlas agent", () => {
    it("extracts prompt from atlas agent config", () => {
      // AtlasAgentConfig requires prompt per schema
      const config = {
        type: "atlas" as const,
        agent: "test-agent",
        description: "Test atlas agent",
        prompt: "Atlas agent prompt",
      };
      expect(extractAgentConfigPrompt(config)).toBe("Atlas agent prompt");
    });

    // Note: AtlasAgentConfig.prompt is REQUIRED in schema
    // No test for "without prompt" - that's an invalid config state
  });

  describe("System agent", () => {
    it("extracts prompt from system agent config", () => {
      // temperature has a default of 0.3 in schema, so output type requires it
      const config = {
        type: "system" as const,
        description: "Test system agent",
        agent: "conversation",
        config: {
          prompt: "System agent prompt",
          temperature: 0.3, // Required in output type (has default)
        },
      };
      expect(extractAgentConfigPrompt(config)).toBe("System agent prompt");
    });

    it("returns empty string for system config without prompt", () => {
      // SystemAgentConfig.config.prompt is optional
      // temperature has a default of 0.3 in schema, so output type requires it
      const config = {
        type: "system" as const,
        description: "Test system agent",
        agent: "conversation",
        config: {
          temperature: 0.3, // Required in output type (has default)
        },
      };
      expect(extractAgentConfigPrompt(config)).toBe("");
    });

    it("returns empty string for system config without config object", () => {
      // SystemAgentConfig.config is optional
      const config = {
        type: "system" as const,
        description: "Test system agent",
        agent: "conversation",
      };
      expect(extractAgentConfigPrompt(config)).toBe("");
    });
  });
});

describe("buildFinalAgentPrompt", () => {
  const documentContext = "## Context Facts\n- Current Date: Monday, January 26, 2026";

  describe("prompt precedence", () => {
    it("uses action.prompt when both action.prompt and agentConfig.prompt exist", () => {
      const result = buildFinalAgentPrompt(
        "Action task instructions",
        "Config fallback prompt",
        documentContext,
      );

      expect(result).toBe(`Action task instructions\n\n${documentContext}`);
      expect(result).not.toContain("Config fallback prompt");
    });

    it("falls back to agentConfig.prompt when action.prompt is undefined", () => {
      const result = buildFinalAgentPrompt(undefined, "Config fallback prompt", documentContext);

      expect(result).toBe(`Config fallback prompt\n\n${documentContext}`);
    });

    it("falls back to agentConfig.prompt when action.prompt is empty string", () => {
      // Empty string is falsy, so falls back to config prompt
      const result = buildFinalAgentPrompt("", "Config fallback prompt", documentContext);

      expect(result).toBe(`Config fallback prompt\n\n${documentContext}`);
    });

    it("returns context only when neither action.prompt nor agentConfig.prompt exist", () => {
      const result = buildFinalAgentPrompt(undefined, "", documentContext);

      expect(result).toBe(documentContext);
    });

    it("returns context only when both prompts are empty strings", () => {
      const result = buildFinalAgentPrompt("", "", documentContext);

      expect(result).toBe(documentContext);
    });
  });

  describe("bundled agent scenario", () => {
    it("bundled agent receives action.prompt prepended to context", () => {
      // Bundled agents (like claude-code) don't have agentConfig, so agentConfigPrompt is ""
      // The fsm-workspace-creator sets action.prompt to the agent's description
      const result = buildFinalAgentPrompt(
        "Clone the friday-platform/friday-studio repository and implement the feature",
        "", // No agent config for bundled agents
        documentContext,
      );

      expect(result.startsWith("Clone the friday-platform/friday-studio repository")).toBe(true);
      expect(result).toContain(documentContext);
    });
  });

  describe("custom agent scenario", () => {
    it("custom agent uses action.prompt over agentConfig.prompt", () => {
      // Custom agents defined in workspace.yml have agentConfig.prompt
      // But if the FSM action also specifies a prompt, it takes precedence
      const result = buildFinalAgentPrompt(
        "Override: specific task for this step",
        "Default: general purpose for this agent",
        documentContext,
      );

      expect(result).toBe(`Override: specific task for this step\n\n${documentContext}`);
      expect(result).not.toContain("Default: general purpose");
    });

    it("custom agent uses agentConfig.prompt when no action.prompt", () => {
      // Custom agent with config prompt, but FSM action doesn't override
      const result = buildFinalAgentPrompt(
        undefined,
        "Default: general purpose for this agent",
        documentContext,
      );

      expect(result).toBe(`Default: general purpose for this agent\n\n${documentContext}`);
    });
  });

  describe("prompt formatting", () => {
    it("separates task prompt from context with double newline", () => {
      const result = buildFinalAgentPrompt("Task prompt", "", documentContext);

      expect(result).toBe(`Task prompt\n\n${documentContext}`);
      // Verify the exact format: prompt, two newlines, context
      const parts = result.split("\n\n");
      expect(parts[0]).toBe("Task prompt");
      expect(parts.slice(1).join("\n\n")).toBe(documentContext);
    });

    it("preserves multiline prompts", () => {
      const multilinePrompt = "Line 1\nLine 2\nLine 3";
      const result = buildFinalAgentPrompt(multilinePrompt, "", documentContext);

      expect(result).toBe(`${multilinePrompt}\n\n${documentContext}`);
    });

    it("preserves complex document context", () => {
      const complexContext = `## Context Facts
- Current Date: Monday, January 26, 2026

## Available Documents

### Document: task-plan (type: plan)
\`\`\`json
{
  "steps": ["step1", "step2"]
}
\`\`\``;

      const result = buildFinalAgentPrompt("Execute the plan", "", complexContext);

      expect(result).toContain("Execute the plan");
      expect(result).toContain("## Context Facts");
      expect(result).toContain("## Available Documents");
      expect(result).toContain("task-plan");
    });
  });
});

describe("validateAgentOutput", () => {
  const fsmContext: Context = { documents: [], state: "idle", results: {} };
  const platformModels = {} as PlatformModels;

  function buildSuccessResult(data: unknown = "agent output"): AgentResult {
    return {
      agentId: "test-agent",
      timestamp: "2026-04-28T00:00:00Z",
      input: "test input",
      ok: true,
      data,
      durationMs: 1,
    };
  }

  function buildVerdict(
    status: VerdictStatus,
    overrides: Partial<ValidationVerdict> = {},
  ): ValidationVerdict {
    return {
      status,
      confidence: status === "pass" ? 0.8 : status === "uncertain" ? 0.4 : 0.2,
      threshold: 0.45,
      issues: [],
      retryGuidance: "",
      ...overrides,
    };
  }

  beforeEach(() => {
    mockValidate.mockReset();
  });

  it("does not throw when verdict status is pass", async () => {
    mockValidate.mockResolvedValue(buildVerdict("pass"));

    await expect(
      validateAgentOutput(buildSuccessResult(), fsmContext, "llm", platformModels),
    ).resolves.toBeUndefined();

    expect(mockValidate).toHaveBeenCalledTimes(1);
  });

  it("does not throw when verdict status is uncertain", async () => {
    mockValidate.mockResolvedValue(buildVerdict("uncertain"));

    await expect(
      validateAgentOutput(buildSuccessResult(), fsmContext, "llm", platformModels),
    ).resolves.toBeUndefined();

    expect(mockValidate).toHaveBeenCalledTimes(1);
  });

  it("throws ValidationFailedError carrying the verdict when status is fail", async () => {
    const verdict = buildVerdict("fail", {
      retryGuidance: "agent fabricated data",
      issues: [
        {
          category: "sourcing",
          severity: "error",
          claim: "company has 500 employees",
          reasoning: "no tools called",
          citation: null,
        },
      ],
    });
    mockValidate.mockResolvedValue(verdict);

    let thrown: unknown;
    try {
      await validateAgentOutput(buildSuccessResult(), fsmContext, "llm", platformModels);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ValidationFailedError);
    expect(thrown).toBeInstanceOf(Error);
    if (thrown instanceof ValidationFailedError) {
      expect(thrown.verdict).toBe(verdict);
      expect(thrown.message).toContain("test-agent");
      expect(thrown.message).toContain("agent fabricated data");
    }
  });

  it("skips hallucination detection for non-LLM agents", async () => {
    await expect(
      validateAgentOutput(buildSuccessResult(), fsmContext, "system", platformModels),
    ).resolves.toBeUndefined();

    expect(mockValidate).not.toHaveBeenCalled();
  });

  it("skips hallucination detection when platformModels is missing", async () => {
    await expect(
      validateAgentOutput(buildSuccessResult(), fsmContext, "llm"),
    ).resolves.toBeUndefined();

    expect(mockValidate).not.toHaveBeenCalled();
  });
});
