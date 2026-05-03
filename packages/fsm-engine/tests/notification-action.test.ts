import { describe, expect, it, vi } from "vitest";
import { getDocumentStore } from "../../document-store/node.ts";
import { FSMEngine } from "../fsm-engine.ts";
import type { FSMBroadcastNotifier, FSMDefinition, FSMEvent } from "../types.ts";

function makeFSM(communicators?: string[]): FSMDefinition {
  return {
    id: "notification-test",
    initial: "start",
    states: {
      start: { on: { GO: { target: "notify" } } },
      notify: {
        entry: [
          {
            type: "notification",
            message: "hello world",
            ...(communicators ? { communicators } : {}),
          },
        ],
        on: { DONE: { target: "end" } },
      },
      end: { type: "final" },
    },
  };
}

describe("FSM notification action", () => {
  it("calls broadcastNotifier with the message and no communicator filter when omitted", async () => {
    const broadcast = vi.fn<FSMBroadcastNotifier["broadcast"]>().mockResolvedValue();
    const notifier: FSMBroadcastNotifier = { broadcast };
    const store = getDocumentStore();
    const scope = {
      workspaceId: `test-${crypto.randomUUID()}`,
      sessionId: `test-session-${crypto.randomUUID()}`,
    };
    const engine = new FSMEngine(makeFSM(), {
      documentStore: store,
      scope,
      broadcastNotifier: notifier,
    });
    await engine.initialize();

    await engine.signal({ type: "GO" });

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({ message: "hello world", communicators: undefined });
  });

  it("forwards the optional communicators allowlist verbatim", async () => {
    const broadcast = vi.fn<FSMBroadcastNotifier["broadcast"]>().mockResolvedValue();
    const store = getDocumentStore();
    const scope = {
      workspaceId: `test-${crypto.randomUUID()}`,
      sessionId: `test-session-${crypto.randomUUID()}`,
    };
    const engine = new FSMEngine(makeFSM(["slack", "telegram"]), {
      documentStore: store,
      scope,
      broadcastNotifier: { broadcast },
    });
    await engine.initialize();

    await engine.signal({ type: "GO" });

    expect(broadcast).toHaveBeenCalledWith({
      message: "hello world",
      communicators: ["slack", "telegram"],
    });
  });

  it("throws a typed error when no broadcastNotifier is configured", async () => {
    const store = getDocumentStore();
    const scope = {
      workspaceId: `test-${crypto.randomUUID()}`,
      sessionId: `test-session-${crypto.randomUUID()}`,
    };
    const engine = new FSMEngine(makeFSM(), { documentStore: store, scope });
    await engine.initialize();

    await expect(engine.signal({ type: "GO" })).rejects.toThrow(/broadcastNotifier/);
  });

  it("emits an action-execution event with a truncated message preview as actionId", async () => {
    const broadcast = vi.fn<FSMBroadcastNotifier["broadcast"]>().mockResolvedValue();
    const longMessage = "x".repeat(120);
    const fsm: FSMDefinition = {
      id: "notification-test",
      initial: "start",
      states: {
        start: { on: { GO: { target: "notify" } } },
        notify: {
          entry: [{ type: "notification", message: longMessage }],
          on: { DONE: { target: "end" } },
        },
        end: { type: "final" },
      },
    };
    const store = getDocumentStore();
    const scope = {
      workspaceId: `test-${crypto.randomUUID()}`,
      sessionId: `test-session-${crypto.randomUUID()}`,
    };
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      broadcastNotifier: { broadcast },
    });
    await engine.initialize();

    const events: FSMEvent[] = [];
    await engine.signal(
      { type: "GO" },
      { sessionId: "test-session", workspaceId: "test-ws", onEvent: (e) => events.push(e) },
    );

    const completed = events.find(
      (e): e is Extract<FSMEvent, { type: "data-fsm-action-execution" }> =>
        e.type === "data-fsm-action-execution" &&
        e.data.actionType === "notification" &&
        e.data.status === "completed",
    );
    expect(completed).toBeDefined();
    // actionId is the message preview, capped at 40 chars — meaningful but
    // bounded so traces and OTel attrs don't carry full message bodies.
    expect(completed?.data.actionId).toBe("x".repeat(40));
    expect(completed?.data.actionId?.length).toBeLessThanOrEqual(40);
  });

  it("propagates broadcaster failures so the FSM step fails loud", async () => {
    const broadcast = vi
      .fn<FSMBroadcastNotifier["broadcast"]>()
      .mockRejectedValue(new Error("no destinations"));
    const store = getDocumentStore();
    const scope = {
      workspaceId: `test-${crypto.randomUUID()}`,
      sessionId: `test-session-${crypto.randomUUID()}`,
    };
    const engine = new FSMEngine(makeFSM(), {
      documentStore: store,
      scope,
      broadcastNotifier: { broadcast },
    });
    await engine.initialize();

    await expect(engine.signal({ type: "GO" })).rejects.toThrow(/no destinations/);
  });
});
