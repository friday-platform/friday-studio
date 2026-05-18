import { describe, expect, test } from "vitest";
import { mapSignalTriggerResponse } from "./trigger.ts";

// MCP tools are reached by LLM clients, so silent shape drift on the
// signal-trigger response envelope is the highest-stakes path among the
// four discriminator call sites. These tests lock the union narrowing
// so a future schema change is caught at test time, not by an LLM that
// then routes a half-shipped envelope back to the user.

describe("mapSignalTriggerResponse — discriminator coverage", () => {
  test("completed → success with sessionId + triggered status", () => {
    const out = mapSignalTriggerResponse("ws-1", "sig-1", {
      status: "completed",
      sessionId: "sess-42",
      output: { hi: 1 },
      summary: "ran",
    });
    expect(out.kind).toBe("success");
    expect(out.payload).toMatchObject({
      workspaceId: "ws-1",
      signalId: "sig-1",
      sessionId: "sess-42",
      status: "triggered",
    });
    // No correlationId leak from the other branch.
    expect(out.payload).not.toHaveProperty("correlationId");
  });

  test("accepted → success with correlationId + accepted status (async path)", () => {
    const out = mapSignalTriggerResponse("ws-1", "sig-1", {
      status: "accepted",
      correlationId: "corr-99",
    });
    expect(out.kind).toBe("success");
    expect(out.payload).toMatchObject({
      workspaceId: "ws-1",
      signalId: "sig-1",
      status: "accepted",
      correlationId: "corr-99",
    });
    // No sessionId leak from the other branch.
    expect(out.payload).not.toHaveProperty("sessionId");
    expect((out.payload.message as string).toLowerCase()).toContain("async");
  });

  test("failed → error envelope with error string", () => {
    const out = mapSignalTriggerResponse("ws-1", "sig-1", {
      status: "failed",
      error: "agent threw",
    });
    expect(out.kind).toBe("error");
    expect(out.payload).toMatchObject({
      workspaceId: "ws-1",
      signalId: "sig-1",
      status: "failed",
      error: "agent threw",
    });
  });

  test("failed without error string → falls back to a sensible default", () => {
    const out = mapSignalTriggerResponse("ws-1", "sig-1", { status: "failed" });
    expect(out.kind).toBe("error");
    expect(out.payload.status).toBe("failed");
    expect(out.payload.error).toBeTruthy();
  });

  test("cancelled → error envelope with reason", () => {
    const out = mapSignalTriggerResponse("ws-1", "sig-1", {
      status: "cancelled",
      reason: "client disconnected",
    });
    expect(out.kind).toBe("error");
    expect(out.payload).toMatchObject({
      workspaceId: "ws-1",
      signalId: "sig-1",
      status: "cancelled",
      error: "client disconnected",
    });
  });

  test("cancelled without reason → falls back to a sensible default", () => {
    const out = mapSignalTriggerResponse("ws-1", "sig-1", { status: "cancelled" });
    expect(out.kind).toBe("error");
    expect(out.payload.status).toBe("cancelled");
    expect(out.payload.error).toBeTruthy();
  });
});
