import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { describe, expect, test } from "vitest";
import { PlaygroundContextAdapter } from "./context.ts";

describe("PlaygroundContextAdapter", () => {
  test("createContext returns AgentContext with playground defaults", () => {
    const adapter = new PlaygroundContextAdapter();
    const { context } = adapter.createContext({});

    expect(context.session.workspaceId).toBe("playground");
    expect(context.session.userId).toBe("playground-user");
    expect(context.session.sessionId).toEqual(expect.any(String));
    expect(context.session.sessionId).toHaveLength(36); // UUID format
    expect(context.env).toEqual({});
    expect(context.tools).toEqual({});
  });

  test("createContext passes env through to context", () => {
    const adapter = new PlaygroundContextAdapter();
    const env = { OPENAI_API_KEY: "sk-test", MODEL: "gpt-4" };
    const { context } = adapter.createContext({ env });

    expect(context.env).toEqual(env);
  });

  test("createContext passes tools through to context", () => {
    const adapter = new PlaygroundContextAdapter();
    const tools = { myTool: { description: "test" } } as unknown as Record<
      string,
      import("@atlas/agent-sdk").AtlasTool
    >;
    const { context } = adapter.createContext({ tools });

    expect(context.tools).toBe(tools);
  });

  test("createContext threads abortSignal into context", () => {
    const adapter = new PlaygroundContextAdapter();
    const controller = new AbortController();
    const { context } = adapter.createContext({ abortSignal: controller.signal });

    expect(context.abortSignal).toBe(controller.signal);
  });

  test("stream emitter fires onStream callback in real-time", () => {
    const adapter = new PlaygroundContextAdapter();
    const chunks: AtlasUIMessageChunk[] = [];
    const { context } = adapter.createContext({ onStream: (chunk) => chunks.push(chunk) });

    const chunk1 = { type: "text-delta", textDelta: "hello" } as unknown as AtlasUIMessageChunk;
    const chunk2 = { type: "text-delta", textDelta: " world" } as unknown as AtlasUIMessageChunk;

    if (!context.stream) throw new Error("expected stream to be defined");
    context.stream.emit(chunk1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(chunk1);

    context.stream.emit(chunk2);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toBe(chunk2);
  });

  test("logger fires onLog callback for each log level", () => {
    const adapter = new PlaygroundContextAdapter();
    const logs: Array<{ level: string; message: string; context?: unknown }> = [];
    const { context } = adapter.createContext({ onLog: (entry) => logs.push(entry) });

    context.logger.info("info message");
    context.logger.warn("warn message", { extra: true });
    context.logger.error("error message");

    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({ level: "info", message: "info message" });
    expect(logs[1]).toMatchObject({
      level: "warn",
      message: "warn message",
      context: { extra: true },
    });
    expect(logs[2]).toMatchObject({ level: "error", message: "error message" });
  });

  test("stream emitter is undefined when no onStream callback provided", () => {
    const adapter = new PlaygroundContextAdapter();
    const { context } = adapter.createContext({});

    expect(context.stream).toBeUndefined();
  });

  test("logger child returns a logger that still fires onLog", () => {
    const adapter = new PlaygroundContextAdapter();
    const logs: Array<{ level: string; message: string; context?: unknown }> = [];
    const { context } = adapter.createContext({ onLog: (entry) => logs.push(entry) });

    const child = context.logger.child({ agentId: "test-agent" });
    child.info("child message");

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "info", message: "child message" });
  });
});
