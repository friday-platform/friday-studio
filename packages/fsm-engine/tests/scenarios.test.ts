import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
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

      assertEquals(engine.state, "approved");
      const order = engine.getDocument("order");
      assert(order);
      assertEquals(order.data.status, "approved");

      const events = engine.emittedEvents;
      assertEquals(events.length, 1);
      assertEquals(events[0]?.event, "order.approved");
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
      assertEquals(engine.state, "pending");
      const order = engine.getDocument("order");
      assert(order);
      assertEquals(order.data.status, "pending");
      assertEquals(engine.emittedEvents.length, 0);
    });

    it("should reject order explicitly", async () => {
      const { engine } = await createTestEngine(orderProcessingFSM, {
        initialState: "pending",
        documents: [
          { id: "order", type: "order", data: { item: "laptop", quantity: 1, status: "pending" } },
        ],
      });

      await engine.signal({ type: "REJECT" });

      assertEquals(engine.state, "rejected");
      const order = engine.getDocument("order");
      assert(order);
      assertEquals(order.data.status, "rejected");
    });
  });

  describe("User Onboarding", () => {
    it("should complete profile and onboard user", async () => {
      const { engine } = await createTestEngine(userOnboardingFSM, { initialState: "new_user" });

      await engine.signal({ type: "COMPLETE_PROFILE", data: { userId: "user-123" } });

      assertEquals(engine.state, "active");
      const profile = engine.getDocument("profile");
      assert(profile);
      assertEquals(profile.data.userId, "user-123");

      const events = engine.emittedEvents;
      assertEquals(events.length, 1);
      assertEquals(events[0]?.event, "user.onboarded");
    });
  });

  describe("Simple Counter", () => {
    it("should increment counter", async () => {
      const { engine } = await createTestEngine(simpleCounterFSM, {
        initialState: "counting",
        documents: [{ id: "counter", type: "counter", data: { value: 0 } }],
      });

      await engine.signal({ type: "INCREMENT" });

      assertEquals(engine.state, "counting");
      const counter = engine.getDocument("counter");
      assert(counter);
      assertEquals(counter.data.value, 1);
    });
  });
});
