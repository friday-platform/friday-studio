import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSetUserIdentity, mockMarkOnboardingComplete } = vi.hoisted(() => ({
  mockSetUserIdentity: vi.fn(),
  mockMarkOnboardingComplete: vi.fn(),
}));

vi.mock("@atlas/core/users/storage", () => ({
  UserStorage: {
    setUserIdentity: mockSetUserIdentity,
    markOnboardingComplete: mockMarkOnboardingComplete,
  },
  ONBOARDING_VERSION: 1,
}));

import { createSetUserIdentityTool } from "./set-user-identity.ts";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

beforeEach(() => {
  mockSetUserIdentity.mockReset();
  mockMarkOnboardingComplete.mockReset();
  mockSetUserIdentity.mockResolvedValue({ ok: true, data: {} });
  mockMarkOnboardingComplete.mockResolvedValue({ ok: true, data: {} });
});

interface ToolWithExecute {
  execute: (input: unknown, opts: unknown) => Promise<unknown>;
  inputSchema: { safeParse: (v: unknown) => { success: boolean } };
}

function getTool(userId: string): ToolWithExecute {
  const tools = createSetUserIdentityTool(userId, logger);
  return tools.set_user_identity as unknown as ToolWithExecute;
}

describe("set_user_identity", () => {
  describe("input validation", () => {
    it("accepts {name: 'Alex'}", () => {
      const tool = getTool("u1");
      expect(tool.inputSchema.safeParse({ name: "Alex" }).success).toBe(true);
    });

    it("accepts {declined: true}", () => {
      const tool = getTool("u1");
      expect(tool.inputSchema.safeParse({ declined: true }).success).toBe(true);
    });

    it("rejects empty input (neither name nor declined)", () => {
      const tool = getTool("u1");
      expect(tool.inputSchema.safeParse({}).success).toBe(false);
    });

    it("rejects both name and declined together", () => {
      const tool = getTool("u1");
      expect(tool.inputSchema.safeParse({ name: "Alex", declined: true }).success).toBe(false);
    });

    it("rejects empty-string name", () => {
      const tool = getTool("u1");
      expect(tool.inputSchema.safeParse({ name: "" }).success).toBe(false);
    });
  });

  describe("execution", () => {
    it("writes name + nameStatus=provided and marks onboarding complete", async () => {
      const tool = getTool("user-99");
      const result = await tool.execute({ name: "Alex" }, {});
      expect(mockSetUserIdentity).toHaveBeenCalledWith("user-99", {
        name: "Alex",
        nameStatus: "provided",
      });
      expect(mockMarkOnboardingComplete).toHaveBeenCalledWith("user-99", 1);
      expect(result).toEqual({ saved: true });
    });

    it("writes nameStatus=declined + declinedAt and marks onboarding complete", async () => {
      const tool = getTool("user-99");
      const result = await tool.execute({ declined: true }, {});
      const call = mockSetUserIdentity.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(call.nameStatus).toBe("declined");
      expect(typeof call.declinedAt).toBe("string");
      expect(mockMarkOnboardingComplete).toHaveBeenCalledWith("user-99", 1);
      expect(result).toEqual({ saved: true });
    });

    it("returns error when setUserIdentity fails (and skips markOnboardingComplete)", async () => {
      mockSetUserIdentity.mockResolvedValueOnce({ ok: false, error: "kv down" });
      const tool = getTool("u1");
      const result = await tool.execute({ name: "Alex" }, {});
      expect(result).toEqual({ error: "Failed to save user identity" });
      expect(mockMarkOnboardingComplete).not.toHaveBeenCalled();
    });

    it("returns error when markOnboardingComplete fails", async () => {
      mockMarkOnboardingComplete.mockResolvedValueOnce({ ok: false, error: "kv down" });
      const tool = getTool("u1");
      const result = await tool.execute({ name: "Alex" }, {});
      expect(result).toEqual({ error: "Failed to mark onboarding complete" });
    });

    it("returns error when setUserIdentity throws", async () => {
      mockSetUserIdentity.mockRejectedValueOnce(new Error("boom"));
      const tool = getTool("u1");
      const result = await tool.execute({ name: "Alex" }, {});
      expect(result).toEqual({ error: "Failed to save user identity" });
    });
  });

  describe("security: userId is closure-captured", () => {
    // The userId is bound at tool-factory time — the model has no input
    // path to override it. This is the load-bearing security property
    // (a model can't smuggle a different identity through tool args).
    it("uses the factory userId regardless of input shape", async () => {
      const tool = getTool("factory-bound-id");
      await tool.execute({ name: "Alex" }, {});
      expect(mockSetUserIdentity).toHaveBeenCalledWith("factory-bound-id", expect.anything());
    });

    it("ignores any extra fields the model might try to pass", async () => {
      const tool = getTool("factory-bound-id");
      // Schema strips unknown keys; even if it didn't, they don't reach setUserIdentity
      await tool.execute({ name: "Alex", userId: "smuggled-id" } as unknown, {});
      expect(mockSetUserIdentity).toHaveBeenCalledWith("factory-bound-id", expect.anything());
    });

    it("two tools created with different userIds remain isolated", async () => {
      const toolA = getTool("user-a");
      const toolB = getTool("user-b");
      await toolA.execute({ name: "Alice" }, {});
      await toolB.execute({ name: "Bob" }, {});
      expect(mockSetUserIdentity.mock.calls[0]?.[0]).toBe("user-a");
      expect(mockSetUserIdentity.mock.calls[1]?.[0]).toBe("user-b");
    });
  });
});
