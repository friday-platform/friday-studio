/**
 * E2 — covers the synchronous `getSystemAgentType` lookup that
 * `WorkspaceRuntime`'s `resolveAgentType` callback delegates to for
 * bundled system agents (workspace-chat, judge-agent). Both must report
 * "atlas" so the validate-classifier's user/atlas → skip rule fires.
 */

import { describe, expect, test } from "vitest";
import { getSystemAgentType } from "./system-adapter.ts";

describe("getSystemAgentType", () => {
  test("workspace-chat resolves to 'atlas'", () => {
    expect(getSystemAgentType("workspace-chat")).toBe("atlas");
  });

  test("judge-agent resolves to 'atlas'", () => {
    expect(getSystemAgentType("judge-agent")).toBe("atlas");
  });

  test("unknown agentId returns undefined", () => {
    expect(getSystemAgentType("not-a-real-agent")).toBeUndefined();
  });

  test("empty string returns undefined", () => {
    expect(getSystemAgentType("")).toBeUndefined();
  });
});
