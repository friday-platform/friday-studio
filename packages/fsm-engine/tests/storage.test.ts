import { assert, assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { FSMDocumentDataSchema } from "../document-schemas.ts";
import { FSMEngine } from "../fsm-engine.ts";
import type { FSMDefinition } from "../types.ts";
import { createTestEngine } from "./lib/test-utils.ts";
import { orderProcessingFSM } from "./scenarios/order-processing.ts";
import { userOnboardingFSM } from "./scenarios/user-onboarding.ts";

describe("FSM Engine - Storage & Persistence", () => {
  describe("Persistence Verification", () => {
    it("should persist state across reload (Order Processing)", async () => {
      const { engine, store, scope } = await createTestEngine(orderProcessingFSM, {
        initialState: "pending",
        documents: [
          { id: "order", type: "order", data: { item: "laptop", quantity: 1, status: "pending" } },
          { id: "inventory", type: "inventory", data: { laptop: 10 } },
        ],
      });

      // 1. Execute transition
      await engine.signal({ type: "APPROVE" });

      // 2. Create NEW engine instance
      const newEngine = new FSMEngine(orderProcessingFSM, { documentStore: store, scope });
      await newEngine.initialize();

      // 3. Verify state in NEW engine
      assertEquals(newEngine.state, "approved");
      const order = newEngine.getDocument("order");
      assert(order);
      assertEquals(order.data.status, "approved");
    });

    it("should persist state across reload (User Onboarding)", async () => {
      const { engine, store, scope } = await createTestEngine(userOnboardingFSM, {
        initialState: "new_user",
      });

      await engine.signal({ type: "COMPLETE_PROFILE", data: { userId: "user-123" } });

      const newEngine = new FSMEngine(userOnboardingFSM, { documentStore: store, scope });
      await newEngine.initialize();

      assertEquals(newEngine.state, "active");
      const profile = newEngine.getDocument("profile");
      assert(profile);
      assertEquals(profile.data.userId, "user-123");
    });
  });

  describe("Transactional Integrity", () => {
    it("should rollback in-memory changes when transition fails", async () => {
      const fsm: FSMDefinition = {
        id: "transaction-bug",
        initial: "start",
        states: {
          start: {
            on: {
              FAIL: {
                target: "end",
                actions: [
                  { type: "code", function: "modifyDoc" },
                  { type: "code", function: "throwError" },
                ],
              },
              RETRY: {
                target: "end",
                actions: [], // Just transition
              },
            },
          },
          end: { type: "final" },
        },
        functions: {
          modifyDoc: {
            type: "action",
            code: `export default (ctx, e, updateDoc) => {
              updateDoc('doc', { val: 1 });
            }`,
          },
          throwError: {
            type: "action",
            code: `export default () => {
              throw new Error("Boom");
            }`,
          },
        },
        documentTypes: { doc: { type: "object", properties: { val: { type: "number" } } } },
      };

      const { engine, store, scope } = await createTestEngine(fsm, {
        initialState: "start",
        documents: [{ id: "doc", type: "doc", data: { val: 0 } }],
      });

      // 1. Trigger failed transition
      // The modifyDoc action runs first, modifying in-memory state to val: 1
      // Then throwError runs, causing the transition to abort
      await assertRejects(async () => await engine.signal({ type: "FAIL" }), Error, "Boom");

      // 2. Check in-memory state - it SHOULD be 0 (rollback) if transactional
      const doc = engine.getDocument("doc");
      assert(doc);

      assertEquals(doc.data.val, 0, "In-memory document should be rolled back after failure");

      // 3. Check store state - it should be 0 (persistence skipped due to error)
      // The store is safe for now because persistence happens at the end
      const storedDoc = await store.read(scope, fsm.id, "doc", FSMDocumentDataSchema);
      assert(storedDoc);
      const storedData = storedDoc.data.data;
      assertEquals(storedData.val, 0, "Stored document should not be updated yet");

      // 4. Trigger successful transition
      // This will trigger persistence of the CURRENT in-memory state
      await engine.signal({ type: "RETRY" });

      // 5. Verify bad state is now persisted
      // If the in-memory state wasn't rolled back, val: 1 is now in the store
      const storedDoc2 = await store.read(scope, fsm.id, "doc", FSMDocumentDataSchema);
      assert(storedDoc2);
      const storedData2 = storedDoc2.data.data;
      assertEquals(storedData2.val, 0, "Bad state should not be persisted after retry");
    });

    it("should prevent direct mutation of document data during failed transitions", async () => {
      const fsm: FSMDefinition = {
        id: "mutation-test",
        initial: "start",
        states: {
          start: {
            on: {
              MUTATE: {
                target: "end",
                actions: [
                  { type: "code", function: "directMutate" },
                  { type: "code", function: "throwError" },
                ],
              },
            },
          },
          end: { type: "final" },
        },
        functions: {
          directMutate: {
            type: "action",
            // This malicious code tries to directly mutate nested properties
            // With shallow clone, this would corrupt the original document
            // With structured clone, mutations are isolated to the transaction
            code: `export default (ctx, e) => {
              const doc = ctx.documents.find(d => d.id === 'nested');
              if (doc && doc.data.nested) {
                // Direct mutation attempt - should not affect original
                doc.data.nested.value = 999;
                doc.data.array.push('mutated');
              }
            }`,
          },
          throwError: {
            type: "action",
            code: `export default () => {
              throw new Error("Transaction failed");
            }`,
          },
        },
        documentTypes: {
          nested: {
            type: "object",
            properties: {
              nested: { type: "object", properties: { value: { type: "number" } } },
              array: { type: "array", items: { type: "string" } },
            },
          },
        },
      };

      const { engine } = await createTestEngine(fsm, {
        initialState: "start",
        documents: [
          { id: "nested", type: "nested", data: { nested: { value: 42 }, array: ["original"] } },
        ],
      });

      // Get original document reference for comparison
      const originalDoc = engine.getDocument("nested");
      assert(originalDoc);
      const originalData = originalDoc.data;
      // @ts-expect-error specific document structure isn't type safe
      const originalNestedValue = originalData.nested.value;
      // @ts-expect-error specific document structure isn't type safe
      const originalArrayLength = originalData.array.length;

      // Trigger transition that mutates then fails
      await assertRejects(
        async () => await engine.signal({ type: "MUTATE" }),
        Error,
        "Transaction failed",
      );

      // Verify document wasn't mutated despite direct mutation attempt
      const docAfterFailure = engine.getDocument("nested");
      assert(docAfterFailure);
      const dataAfterFailure = docAfterFailure.data;

      assertEquals(
        // @ts-expect-error specific document structure isn't type safe
        dataAfterFailure.nested.value,
        originalNestedValue,
        "Nested object should not be mutated after failed transition",
      );

      assertEquals(
        // @ts-expect-error specific document structure isn't type safe
        dataAfterFailure.array.length,
        originalArrayLength,
        "Array should not be mutated after failed transition",
      );
      assertEquals(
        // @ts-expect-error specific document structure isn't type safe
        dataAfterFailure.array.at(0),
        "original",
        "Array contents should remain unchanged",
      );

      // Cleanup
      engine.stop();
    });
  });
});
