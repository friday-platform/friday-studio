/**
 * Tests for agent prompt precedence logic.
 *
 * These tests verify the prompt precedence behavior:
 * 1. action.prompt takes priority over agentConfig.prompt
 * 2. If no action.prompt, falls back to agentConfig.prompt
 * 3. If neither exists, returns context only
 */

import { describe, expect, it } from "vitest";
import { buildFinalAgentPrompt, extractAgentConfigPrompt } from "./agent-helpers.ts";

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
        "Clone the tempestteam/atlas repository and implement the feature",
        "", // No agent config for bundled agents
        documentContext,
      );

      expect(result.startsWith("Clone the tempestteam/atlas repository")).toBe(true);
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
