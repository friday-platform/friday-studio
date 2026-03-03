/**
 * Tests for agent prompt precedence logic.
 *
 * These tests verify the prompt precedence behavior:
 * 1. action.prompt takes priority over agentConfig.prompt
 * 2. If no action.prompt, falls back to agentConfig.prompt
 * 3. If neither exists, returns context only
 */

import type { ResourceMetadata, ResourceStorageAdapter } from "@atlas/ledger";
import { describe, expect, it, vi } from "vitest";
import {
  buildAgentPrompt,
  buildFinalAgentPrompt,
  extractAgentConfigPrompt,
} from "./agent-helpers.ts";

vi.mock("@atlas/fsm-engine", () => ({
  expandArtifactRefsInDocuments: vi.fn((docs: unknown[]) => Promise.resolve(docs)),
}));

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

/** Create a mock ResourceStorageAdapter with listResources pre-configured */
function createMockAdapter(resources: ResourceMetadata[]): ResourceStorageAdapter {
  return {
    init: vi.fn<() => Promise<void>>(),
    destroy: vi.fn<() => Promise<void>>(),
    provision: vi.fn(),
    query: vi.fn(),
    mutate: vi.fn(),
    publish: vi.fn(),
    replaceVersion: vi.fn(),
    listResources: vi.fn<() => Promise<ResourceMetadata[]>>().mockResolvedValue(resources),
    getResource: vi.fn().mockResolvedValue(null),
    deleteResource: vi.fn<() => Promise<void>>(),
    linkRef: vi.fn(),
    resetDraft: vi.fn<() => Promise<void>>(),
    publishAllDirty: vi.fn<(workspaceId: string) => Promise<number>>().mockResolvedValue(0),
    getSkill: vi
      .fn<() => Promise<string>>()
      .mockResolvedValue("# Resource Data Access (SQLite)\n\nMock skill text"),
  };
}

describe("buildAgentPrompt", () => {
  const minimalContext = { documents: [], state: "idle", results: {} };
  const minimalSignal = { type: "test" };

  describe("resources section", () => {
    const meta = { id: "res-1", userId: "local", workspaceId: "ws-123", currentVersion: 1 };

    it("renders workspace resources section with documents", async () => {
      const adapter = createMockAdapter([
        {
          ...meta,
          slug: "grocery_list",
          type: "document",
          name: "Grocery List",
          description: "Tracks items to purchase with quantities and units",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          ...meta,
          slug: "recipes",
          type: "document",
          name: "Recipes",
          description: "Collection of saved recipes",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ]);

      const result = await buildAgentPrompt(
        "agent-1",
        minimalContext,
        minimalSignal,
        undefined,
        adapter,
        "ws-123",
      );

      expect(result).toContain("## Workspace Resources");
      expect(result).toContain("resource_read for queries");
      expect(result).toContain("resource_write for mutations");
      expect(result).toContain("Documents (use resource_read for queries");
      expect(result).toContain(
        "- grocery_list: Tracks items to purchase with quantities and units",
      );
      expect(result).toContain("- recipes: Collection of saved recipes");
      expect(result).toContain("# Resource Data Access (SQLite)");
    });

    it("renders document resources", async () => {
      const adapter = createMockAdapter([
        {
          ...meta,
          slug: "meal_plans",
          type: "document",
          name: "Meal Plans",
          description: "Imported meal schedule from uploaded CSV",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ]);

      const result = await buildAgentPrompt(
        "agent-1",
        minimalContext,
        minimalSignal,
        undefined,
        adapter,
        "ws-123",
      );

      expect(result).toContain("- meal_plans: Imported meal schedule from uploaded CSV");
    });

    it("skips non-document resource types in guidance", async () => {
      const adapter = createMockAdapter([
        {
          ...meta,
          slug: "contacts",
          type: "external_ref",
          name: "Contacts",
          description: "Access via google-sheets MCP tools",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ]);

      const result = await buildAgentPrompt(
        "agent-1",
        minimalContext,
        minimalSignal,
        undefined,
        adapter,
        "ws-123",
      );

      // Non-document types are filtered out — ResourceMetadata lacks provider/ref fields
      expect(result).not.toContain("## Workspace Resources");
    });

    it("does not render resources section when adapter is undefined", async () => {
      const result = await buildAgentPrompt("agent-1", minimalContext, minimalSignal);

      expect(result).not.toContain("## Workspace Resources");
    });

    it("does not render resources section when no resources exist", async () => {
      const adapter = createMockAdapter([]);

      const result = await buildAgentPrompt(
        "agent-1",
        minimalContext,
        minimalSignal,
        undefined,
        adapter,
        "ws-123",
      );

      expect(result).not.toContain("## Workspace Resources");
    });

    it("renders only document resources from mixed types", async () => {
      const adapter = createMockAdapter([
        {
          ...meta,
          slug: "grocery_list",
          type: "document",
          name: "Grocery List",
          description: "Items to buy",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          ...meta,
          slug: "contacts",
          type: "external_ref",
          name: "Contacts",
          description: "Google Sheets contacts",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ]);

      const result = await buildAgentPrompt(
        "agent-1",
        minimalContext,
        minimalSignal,
        undefined,
        adapter,
        "ws-123",
      );

      expect(result).toContain("Documents (use resource_read for queries");
      expect(result).toContain("- grocery_list: Items to buy");
      // External refs are filtered — ResourceMetadata lacks provider/ref
      expect(result).not.toContain("External Resources:");
    });
  });
});
