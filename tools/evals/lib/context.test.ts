import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";
import { AgentContextAdapter } from "./context.ts";

/** Creates a valid AtlasUIMessageChunk for testing. */
function textDelta(delta: string): AtlasUIMessageChunk {
  return { type: "text-delta", id: crypto.randomUUID(), delta } satisfies AtlasUIMessageChunk;
}

describe("AgentContextAdapter", () => {
  describe("session", () => {
    it("returns unique session IDs per call", () => {
      const adapter = new AgentContextAdapter();
      const a = adapter.createContext();
      const b = adapter.createContext();

      expect(a.context.session.sessionId).not.toBe(b.context.session.sessionId);
      expect(a.context.session.streamId).not.toBe(b.context.session.streamId);
    });

    it("has eval-workspace and eval-user defaults", () => {
      const adapter = new AgentContextAdapter();
      const { context } = adapter.createContext();

      expect(context.session).toMatchObject({ workspaceId: "eval-workspace", userId: "eval-user" });
    });
  });

  describe("tools and env", () => {
    it("uses provided tools", () => {
      const tools = {};
      const adapter = new AgentContextAdapter(tools);
      const { context } = adapter.createContext();

      expect(context.tools).toBe(tools);
    });

    it("passes through env", () => {
      const env = { API_KEY: "sk-test-123" };
      const adapter = new AgentContextAdapter({}, env);
      const { context } = adapter.createContext();

      expect(context.env).toBe(env);
    });
  });

  describe("stream events", () => {
    it("captures stream events", () => {
      const adapter = new AgentContextAdapter();
      const { context, getStreamEvents } = adapter.createContext();

      const event = textDelta("hello");
      context.stream?.emit(event);

      expect(getStreamEvents()).toHaveLength(1);
    });

    it("isolates captures between contexts", () => {
      const adapter = new AgentContextAdapter();
      const first = adapter.createContext();
      const second = adapter.createContext();

      first.context.stream?.emit(textDelta("first"));
      second.context.stream?.emit(textDelta("second-a"));
      second.context.stream?.emit(textDelta("second-b"));

      expect(first.getStreamEvents()).toHaveLength(1);
      expect(second.getStreamEvents()).toHaveLength(2);
    });
  });

  describe("logs", () => {
    it("captures log entries", () => {
      const adapter = new AgentContextAdapter();
      const { context, getLogs } = adapter.createContext();

      context.logger.info("test message", { key: "value" });

      const logs = getLogs();
      expect(logs).toHaveLength(1);

      const entry = logs[0];
      expect.assert(entry !== undefined);
      expect(entry).toMatchObject({ level: "info", message: "test message" });
    });

    it("child logger shares log capture", () => {
      const adapter = new AgentContextAdapter();
      const { context, getLogs } = adapter.createContext();

      const child = context.logger.child({ agentId: "test-agent" });
      child.info("child message");

      const logs = getLogs();
      expect(logs).toHaveLength(1);

      const entry = logs[0];
      expect.assert(entry !== undefined);
      expect(entry.message).toBe("child message");
    });

    it("isolates captures between contexts", () => {
      const adapter = new AgentContextAdapter();
      const first = adapter.createContext();
      const second = adapter.createContext();

      first.context.logger.info("first");
      second.context.logger.info("second-a");
      second.context.logger.info("second-b");

      expect(first.getLogs()).toHaveLength(1);
      expect(second.getLogs()).toHaveLength(2);
    });
  });

  describe("abort signal", () => {
    it("passes signal through to context", () => {
      const adapter = new AgentContextAdapter();
      const controller = new AbortController();
      const { context } = adapter.createContext({ signal: controller.signal });

      expect(context.abortSignal).toBe(controller.signal);
    });
  });
});
