/**
 * Tests for resolveRuntimeAgentId — maps workspace agent keys
 * to runtime agent IDs for the orchestrator.
 */

import { describe, expect, test } from "vitest";
import { atlasAgent, llmAgent, systemAgent } from "./mutations/test-fixtures.ts";
import { resolveRuntimeAgentId } from "./resolve-runtime-agent.ts";

describe("resolveRuntimeAgentId", () => {
  test("atlas agent → returns agentConfig.agent", () => {
    const config = atlasAgent({ agent: "claude-code" });
    expect(resolveRuntimeAgentId(config, "repo-cloner")).toBe("claude-code");
  });

  test("system agent → returns agentConfig.agent", () => {
    const config = systemAgent({ agent: "conversation" });
    expect(resolveRuntimeAgentId(config, "chat")).toBe("conversation");
  });

  test("undefined config → returns agentId unchanged (backward compat)", () => {
    expect(resolveRuntimeAgentId(undefined, "claude-code")).toBe("claude-code");
  });

  test("LLM agent → returns agentId unchanged", () => {
    const config = llmAgent();
    expect(resolveRuntimeAgentId(config, "summarizer")).toBe("summarizer");
  });
});
