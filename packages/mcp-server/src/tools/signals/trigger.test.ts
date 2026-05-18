import { SignalTriggerResponseSchema } from "@atlas/core";
import { describe, expect, test } from "vitest";
import { mapSignalTriggerResponse } from "./trigger.ts";

// MCP tools are reached by LLM clients, so silent shape drift on the
// signal-trigger response envelope is the highest-stakes path among the
// four discriminator call sites. These tests lock TWO surfaces:
//   1. `mapSignalTriggerResponse` correctly narrows the
//      `completed | accepted` union from atlasd.
//   2. `SignalTriggerResponseSchema` validates atlasd's actual 2xx body
//      shape at runtime — schema drift (renamed field, new status)
//      surfaces here before the LLM client sees a malformed envelope.
//
// Atlasd emits only two 2xx body shapes (apps/atlasd/routes/workspaces/index.ts):
//   - status: "completed" + sessionId  (synchronous mode)
//   - status: "accepted"  + correlationId  (?nowait=true / webhook mode)
// Terminal failures return non-2xx (caught earlier via result.ok === false),
// not a status:"failed" body. The schema deliberately doesn't allow
// failed/cancelled — adding them would protect a hypothetical contract.

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
});

describe("SignalTriggerResponseSchema — runtime validation at the atlasd seam", () => {
  test("parses a valid completed envelope", () => {
    const r = SignalTriggerResponseSchema.safeParse({
      status: "completed",
      sessionId: "s1",
      output: [],
      summary: "",
    });
    expect(r.success).toBe(true);
  });

  test("parses a valid accepted envelope", () => {
    const r = SignalTriggerResponseSchema.safeParse({ status: "accepted", correlationId: "c1" });
    expect(r.success).toBe(true);
  });

  test("rejects an unknown status (the load-bearing drift guard)", () => {
    // If atlasd ever starts returning a new status (e.g. "queued") in a
    // 2xx body, this assertion fails — forcing the team to either widen
    // the schema deliberately or fix atlasd.
    const r = SignalTriggerResponseSchema.safeParse({ status: "queued", correlationId: "c1" });
    expect(r.success).toBe(false);
  });

  test("rejects completed without sessionId (caught at the seam, not downstream)", () => {
    const r = SignalTriggerResponseSchema.safeParse({ status: "completed" });
    expect(r.success).toBe(false);
  });

  test("rejects accepted without correlationId", () => {
    const r = SignalTriggerResponseSchema.safeParse({ status: "accepted" });
    expect(r.success).toBe(false);
  });

  test("rejects status:failed (atlasd surfaces failures as non-2xx, not as a 2xx failed envelope)", () => {
    const r = SignalTriggerResponseSchema.safeParse({ status: "failed", error: "x" });
    expect(r.success).toBe(false);
  });
});
