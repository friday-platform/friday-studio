/**
 * Unit tests for JWT-based OAuth state encoding
 * Tests security properties: signature verification, expiration, malformed input
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeState, encodeState, type StatePayload } from "./jwt-state.ts";

describe("jwt-state", () => {
  const payload: Omit<StatePayload, "exp"> = {
    v: "code-verifier-12345",
    p: "test-provider",
    c: "https://link.example.com/callback",
    r: "https://app.example.com/settings",
  };

  it("roundtrip: encode → decode preserves payload", async () => {
    const state = await encodeState(payload);
    const decoded = await decodeState(state);
    expect(decoded.v).toEqual(payload.v);
    expect(decoded.p).toEqual(payload.p);
    expect(decoded.c).toEqual(payload.c);
    expect(decoded.r).toEqual(payload.r);
  });

  it("tampered signature → throws", async () => {
    const state = await encodeState(payload);
    const tampered = `${state.slice(0, -10)}xxxxxxxxxx`;
    await expect(decodeState(tampered)).rejects.toThrow(/signature|invalid|verification/i);
  });

  it("malformed JWT → throws", async () => {
    await expect(decodeState("not.a.jwt")).rejects.toThrow();
    await expect(decodeState("")).rejects.toThrow();
    await expect(decodeState("only.two.parts")).rejects.toThrow();
  });

  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("expired state → throws", async () => {
      // Create state at time=0
      const state = await encodeState(payload);

      // Fast-forward 11 minutes (past 10min expiration)
      vi.advanceTimersByTime(11 * 60 * 1000);

      // Verification should fail due to expiration
      await expect(decodeState(state)).rejects.toThrow(/exp|expired/i);
    });

    it("state valid before expiration", async () => {
      const state = await encodeState(payload);

      // Fast-forward 5 minutes (within 10min expiration)
      vi.advanceTimersByTime(5 * 60 * 1000);

      // Should still be valid
      const decoded = await decodeState(state);
      expect(decoded.v).toEqual(payload.v);
    });
  });

  it("encodes optional fields", async () => {
    const payloadWithOptionals: Omit<StatePayload, "exp"> = {
      ...payload,
      u: "user-123",
      i: "client-abc",
    };

    const state = await encodeState(payloadWithOptionals);
    const decoded = await decodeState(state);

    expect(decoded.u).toEqual("user-123");
    expect(decoded.i).toEqual("client-abc");
  });
});
