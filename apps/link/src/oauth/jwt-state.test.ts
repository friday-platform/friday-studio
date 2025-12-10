/**
 * Unit tests for JWT-based OAuth state encoding
 * Tests security properties: signature verification, expiration, malformed input
 */

import { assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { decodeState, encodeState, type StatePayload } from "./jwt-state.ts";

Deno.test("jwt-state", async (t) => {
  const payload: Omit<StatePayload, "exp"> = {
    v: "code-verifier-12345",
    p: "test-provider",
    c: "https://link.example.com/callback",
    r: "https://app.example.com/settings",
  };

  await t.step("roundtrip: encode → decode preserves payload", async () => {
    const state = await encodeState(payload);
    const decoded = await decodeState(state);
    assertEquals(decoded.v, payload.v);
    assertEquals(decoded.p, payload.p);
    assertEquals(decoded.c, payload.c);
    assertEquals(decoded.r, payload.r);
  });

  await t.step("tampered signature → throws", async () => {
    const state = await encodeState(payload);
    const tampered = `${state.slice(0, -10)}xxxxxxxxxx`;
    const error = await assertRejects(() => decodeState(tampered), Error);
    assertEquals(
      /signature|invalid|verification/i.test(error.message),
      true,
      `Expected error message to match signature/invalid/verification, got: ${error.message}`,
    );
  });

  await t.step("malformed JWT → throws", async () => {
    await assertRejects(() => decodeState("not.a.jwt"));
    await assertRejects(() => decodeState(""));
    await assertRejects(() => decodeState("only.two.parts"));
  });

  await t.step("expired state → throws", async () => {
    using time = new FakeTime();

    // Create state at time=0
    const state = await encodeState(payload);

    // Fast-forward 11 minutes (past 10min expiration)
    time.tick(11 * 60 * 1000);

    // Verification should fail due to expiration
    const error = await assertRejects(() => decodeState(state), Error);
    assertEquals(
      /exp|expired/i.test(error.message),
      true,
      `Expected error message to match exp/expired, got: ${error.message}`,
    );
  });

  await t.step("encodes optional fields", async () => {
    const payloadWithOptionals: Omit<StatePayload, "exp"> = {
      ...payload,
      u: "user-123",
      i: "client-abc",
    };

    const state = await encodeState(payloadWithOptionals);
    const decoded = await decodeState(state);

    assertEquals(decoded.u, "user-123");
    assertEquals(decoded.i, "client-abc");
  });

  await t.step("state valid before expiration", async () => {
    using time = new FakeTime();

    const state = await encodeState(payload);

    // Fast-forward 5 minutes (within 10min expiration)
    time.tick(5 * 60 * 1000);

    // Should still be valid
    const decoded = await decodeState(state);
    assertEquals(decoded.v, payload.v);
  });
});
