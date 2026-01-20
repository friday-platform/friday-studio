import { describe, expect, it } from "vitest";
import { createTestEngine } from "./lib/test-utils.ts";
import { orderProcessingFSM } from "./scenarios/order-processing.ts";
import { simpleCounterFSM } from "./scenarios/simple-counter.ts";
import { userOnboardingFSM } from "./scenarios/user-onboarding.ts";

describe("FSM Engine - Scenarios", () => {
  describe("Order Processing", () => {
    it("should approve order when inventory is sufficient", async () => {
      const { engine } = await createTestEngine(orderProcessingFSM, {
        initialState: "pending",
        documents: [
          { id: "order", type: "order", data: { item: "laptop", quantity: 1, status: "pending" } },
          { id: "inventory", type: "inventory", data: { laptop: 10 } },
        ],
      });

      await engine.signal({ type: "APPROVE" });

      expect(engine.state).toBe("approved");
      expect(engine.getDocument("order")).toMatchObject({ data: { status: "approved" } });
      expect(engine.emittedEvents).toHaveLength(1);
      expect(engine.emittedEvents[0]).toMatchObject({ event: "order.approved" });
    });

    it("should not approve order when inventory is insufficient", async () => {
      const { engine } = await createTestEngine(orderProcessingFSM, {
        initialState: "pending",
        documents: [
          {
            id: "order",
            type: "order",
            data: { item: "gold-bar", quantity: 5, status: "pending" },
          },
          { id: "inventory", type: "inventory", data: { "gold-bar": 0 } },
        ],
      });

      await engine.signal({ type: "APPROVE" });

      // Should stay in pending because guard failed
      expect(engine.state).toBe("pending");
      expect(engine.getDocument("order")).toMatchObject({ data: { status: "pending" } });
      expect(engine.emittedEvents).toHaveLength(0);
    });

    it("should reject order explicitly", async () => {
      const { engine } = await createTestEngine(orderProcessingFSM, {
        initialState: "pending",
        documents: [
          { id: "order", type: "order", data: { item: "laptop", quantity: 1, status: "pending" } },
        ],
      });

      await engine.signal({ type: "REJECT" });

      expect(engine.state).toBe("rejected");
      expect(engine.getDocument("order")).toMatchObject({ data: { status: "rejected" } });
    });
  });

  describe("User Onboarding", () => {
    it("should complete profile and onboard user", async () => {
      const { engine } = await createTestEngine(userOnboardingFSM, { initialState: "new_user" });

      await engine.signal({ type: "COMPLETE_PROFILE", data: { userId: "user-123" } });

      expect(engine.state).toBe("active");
      expect(engine.getDocument("profile")).toMatchObject({ data: { userId: "user-123" } });
      expect(engine.emittedEvents).toHaveLength(1);
      expect(engine.emittedEvents[0]).toMatchObject({ event: "user.onboarded" });
    });
  });

  describe("Simple Counter", () => {
    it("should increment counter", async () => {
      const { engine } = await createTestEngine(simpleCounterFSM, {
        initialState: "counting",
        documents: [{ id: "counter", type: "counter", data: { value: 0 } }],
      });

      await engine.signal({ type: "INCREMENT" });

      expect(engine.state).toBe("counting");
      expect(engine.getDocument("counter")).toMatchObject({ data: { value: 1 } });
    });
  });
});
