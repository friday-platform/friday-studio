import { describe, expect, it } from "vitest";
import { createTestEngine } from "./lib/test-utils.ts";
import { orderProcessingFSM } from "./scenarios/order-processing.ts";
import { simpleCounterFSM } from "./scenarios/simple-counter.ts";
import { userOnboardingFSM } from "./scenarios/user-onboarding.ts";

describe("FSM Engine - Scenarios", () => {
  describe("Order Processing", () => {
    it("should approve order", async () => {
      const { engine } = await createTestEngine(orderProcessingFSM, { initialState: "pending" });

      await engine.signal({ type: "APPROVE" });

      expect(engine.state).toBe("approved");
      expect(engine.emittedEvents).toHaveLength(1);
      expect(engine.emittedEvents[0]).toMatchObject({ event: "order.approved" });
    });

    it("should reject order explicitly", async () => {
      const { engine } = await createTestEngine(orderProcessingFSM, { initialState: "pending" });

      await engine.signal({ type: "REJECT" });

      expect(engine.state).toBe("rejected");
    });
  });

  describe("User Onboarding", () => {
    it("should complete profile and onboard user", async () => {
      const { engine } = await createTestEngine(userOnboardingFSM, { initialState: "new_user" });

      await engine.signal({ type: "COMPLETE_PROFILE", data: { userId: "user-123" } });

      expect(engine.state).toBe("active");
      expect(engine.emittedEvents).toHaveLength(1);
      expect(engine.emittedEvents[0]).toMatchObject({ event: "user.onboarded" });
    });
  });

  describe("Simple Counter", () => {
    it("should self-transition on INCREMENT", async () => {
      const { engine } = await createTestEngine(simpleCounterFSM, { initialState: "counting" });

      await engine.signal({ type: "INCREMENT" });

      expect(engine.state).toBe("counting");
    });

    it("should stop on STOP", async () => {
      const { engine } = await createTestEngine(simpleCounterFSM, { initialState: "counting" });

      await engine.signal({ type: "STOP" });

      expect(engine.state).toBe("done");
    });
  });
});
