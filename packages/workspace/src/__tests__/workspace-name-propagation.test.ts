/**
 * Tests that workspace name propagates through the key paths:
 * - AgentSessionDataSchema includes workspaceName
 * - DocumentScope includes optional workspaceName
 * - ImprovementLoopInput includes workspaceName
 * - ImproverAgentInput includes workspaceName
 */

import { AgentSessionDataSchema } from "@atlas/agent-sdk";
import type { DocumentScope } from "@atlas/document-store";
import { describe, expect, it } from "vitest";
import type { ImprovementLoopInput, ImproverAgentInput } from "../improvement-loop.ts";

describe("workspace name propagation", () => {
  describe("AgentSessionDataSchema", () => {
    it("accepts workspaceName when provided", () => {
      const data = { sessionId: "sess-1", workspaceId: "ws-123", workspaceName: "My Workspace" };
      const result = AgentSessionDataSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workspaceName).toBe("My Workspace");
      }
    });

    it("allows session data without workspaceName (optional)", () => {
      const data = { sessionId: "sess-1", workspaceId: "ws-123" };
      const result = AgentSessionDataSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workspaceName).toBeUndefined();
      }
    });
  });

  describe("DocumentScope", () => {
    it("accepts workspaceName as optional", () => {
      const scopeWithName: DocumentScope = { workspaceId: "ws-123", workspaceName: "My Workspace" };
      expect(scopeWithName.workspaceName).toBe("My Workspace");

      const scopeWithoutName: DocumentScope = { workspaceId: "ws-123" };
      expect(scopeWithoutName.workspaceName).toBeUndefined();
    });
  });

  describe("ImprovementLoopInput", () => {
    it("requires workspaceName in the input shape", () => {
      const input: Pick<ImprovementLoopInput, "workspaceId" | "workspaceName"> = {
        workspaceId: "ws-123",
        workspaceName: "My Workspace",
      };
      expect(input.workspaceName).toBe("My Workspace");
    });
  });

  describe("ImproverAgentInput", () => {
    it("requires workspaceName in the input shape", () => {
      const input: Pick<ImproverAgentInput, "workspaceId" | "workspaceName"> = {
        workspaceId: "ws-123",
        workspaceName: "My Workspace",
      };
      expect(input.workspaceName).toBe("My Workspace");
    });
  });
});
