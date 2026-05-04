import { describe, expect, it } from "vitest";
import { ChatTurnRegistry, ChatTurnShutdownError } from "./chat-turn-registry.ts";

describe("ChatTurnRegistry.drainShutdown", () => {
  it("returns immediately when no turns are in-flight", async () => {
    const reg = new ChatTurnRegistry();
    const start = Date.now();
    await reg.drainShutdown(5000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("aborts all in-flight controllers with a shutdown reason", async () => {
    const reg = new ChatTurnRegistry();
    const a = reg.replace("chat-a");
    const b = reg.replace("chat-b");

    // Owners release on completion. Schedule those releases to land
    // shortly after we kick off drainShutdown — simulating each turn's
    // onFinish completing in response to the abort signal.
    setTimeout(() => {
      reg.release("chat-a", a);
      reg.release("chat-b", b);
    }, 20);

    await reg.drainShutdown(2000);

    expect(a.signal.aborted).toBe(true);
    expect(a.signal.reason).toBeInstanceOf(ChatTurnShutdownError);
    expect(b.signal.aborted).toBe(true);
    expect(reg.get("chat-a")).toBeUndefined();
    expect(reg.get("chat-b")).toBeUndefined();
  });

  it("clears stragglers and returns once timeout elapses", async () => {
    const reg = new ChatTurnRegistry();
    reg.replace("chat-stuck"); // never released — simulates a turn that won't finish

    const start = Date.now();
    await reg.drainShutdown(150);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(400);
    expect(reg.get("chat-stuck")).toBeUndefined();
  });
});
