import { describe, expect, it } from "vitest";
import { ChatTurnRegistry, ChatTurnShutdownError } from "./chat-turn-registry.ts";

// Registry methods are now keyed by `(workspaceId, chatId)`. Tests
// stick to a single workspace; cross-tenant collision is exercised
// directly by the dedicated regression test below.
const WS = "ws-test";

describe("ChatTurnRegistry.drainShutdown", () => {
  it("returns immediately when no turns are in-flight", async () => {
    const reg = new ChatTurnRegistry();
    const start = Date.now();
    await reg.drainShutdown(5000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("aborts all in-flight controllers with a shutdown reason", async () => {
    const reg = new ChatTurnRegistry();
    const a = reg.replace(WS, "chat-a");
    const b = reg.replace(WS, "chat-b");

    // Owners release on completion. Schedule those releases to land
    // shortly after we kick off drainShutdown — simulating each turn's
    // onFinish completing in response to the abort signal.
    setTimeout(() => {
      reg.release(WS, "chat-a", a);
      reg.release(WS, "chat-b", b);
    }, 20);

    await reg.drainShutdown(2000);

    expect(a.signal.aborted).toBe(true);
    expect(a.signal.reason).toBeInstanceOf(ChatTurnShutdownError);
    expect(b.signal.aborted).toBe(true);
    expect(reg.get(WS, "chat-a")).toBeUndefined();
    expect(reg.get(WS, "chat-b")).toBeUndefined();
  });

  it("clears stragglers and returns once timeout elapses", async () => {
    const reg = new ChatTurnRegistry();
    reg.replace(WS, "chat-stuck"); // never released — simulates a turn that won't finish

    const start = Date.now();
    await reg.drainShutdown(150);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(400);
    expect(reg.get(WS, "chat-stuck")).toBeUndefined();
  });
});

describe("ChatTurnRegistry — cross-workspace isolation", () => {
  it("replace(ws-A, chatId) does not abort an in-flight controller in ws-B with the same chatId", () => {
    // Client-supplied chat ids can collide across workspaces. A POST to
    // `/api/workspaces/A/chat` with a chat id that happens to exist in
    // workspace B must not abort B's turn.
    const reg = new ChatTurnRegistry();
    const bController = reg.replace("ws-B", "chat-collide");

    reg.replace("ws-A", "chat-collide");

    expect(bController.signal.aborted).toBe(false);
    expect(reg.get("ws-B", "chat-collide")).toBe(bController);
  });

  it("abort(ws-A, chatId) is scoped to ws-A — ws-B's controller stays live", () => {
    const reg = new ChatTurnRegistry();
    const aController = reg.replace("ws-A", "chat-collide");
    const bController = reg.replace("ws-B", "chat-collide");

    const aborted = reg.abort("ws-A", "chat-collide");

    expect(aborted).toBe(true);
    expect(aController.signal.aborted).toBe(true);
    expect(bController.signal.aborted).toBe(false);
    expect(reg.get("ws-B", "chat-collide")).toBe(bController);
  });
});
