import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { FSMDefinition } from "../types.ts";
import { createTestEngine } from "./lib/test-utils.ts";

describe("FSM Engine - Document Lifecycle", () => {
  describe("deleteDoc() API", () => {
    it("should delete documents via context.deleteDoc", async () => {
      const fsm: FSMDefinition = {
        id: "delete-test",
        initial: "idle",
        states: {
          idle: {
            entry: [{ type: "code", function: "init_docs" }],
            on: {
              DELETE: { target: "active", actions: [{ type: "code", function: "deleteDoc1" }] },
            },
          },
          active: {},
        },
        documentTypes: {
          TestDoc: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
        functions: {
          init_docs: {
            type: "action",
            code: `export default function init_docs(context, event) {
              if (!context.documents.find(d => d.id === 'doc1')) {
                context.createDoc?.({ id: 'doc1', type: 'TestDoc', data: { value: 'initial' } });
              }
              if (!context.documents.find(d => d.id === 'doc2')) {
                context.createDoc?.({ id: 'doc2', type: 'TestDoc', data: { value: 'initial' } });
              }
            }`,
          },
          deleteDoc1: {
            type: "action",
            code: `export default function deleteDoc1(context, event) {
              context.deleteDoc?.('doc1');
            }`,
          },
        },
      };

      const { engine } = await createTestEngine(fsm);

      // Initially two documents exist (created by idle entry action)
      assertEquals(engine.documents.length, 2);
      assertEquals(engine.documents.find((d) => d.id === "doc1")?.id, "doc1");

      // Delete doc1 (transition to active state)
      await engine.signal({ type: "DELETE" });

      // Only doc2 should remain
      assertEquals(engine.documents.length, 1);
      assertEquals(
        engine.documents.find((d) => d.id === "doc1"),
        undefined,
      );
      assertEquals(engine.documents.find((d) => d.id === "doc2")?.id, "doc2");
    });

    it("should be idempotent - deleting non-existent document is no-op", async () => {
      const fsm: FSMDefinition = {
        id: "delete-idempotent-test",
        initial: "idle",
        states: {
          idle: {
            on: {
              DELETE: {
                target: "active",
                actions: [{ type: "code", function: "deleteNonExistent" }],
              },
            },
          },
          active: {},
        },
        functions: {
          deleteNonExistent: {
            type: "action",
            code: `export default function deleteNonExistent(context, event) {
              // Delete non-existent document - should be safe
              context.deleteDoc?.('non-existent-doc');
              // Delete it again - should also be safe
              context.deleteDoc?.('non-existent-doc');
            }`,
          },
        },
      };

      const { engine } = await createTestEngine(fsm);

      // Should not throw, just be a no-op
      await engine.signal({ type: "DELETE" });
      assertEquals(engine.state, "active");
      assertEquals(engine.documents.length, 0);
    });
  });

  describe("Selective Cleanup", () => {
    it("should allow selective document cleanup while preserving stateful data", async () => {
      const fsm: FSMDefinition = {
        id: "selective-cleanup",
        initial: "idle",
        states: {
          idle: {
            entry: [{ type: "code", function: "cleanup_temp_docs" }],
            on: { START: { target: "step_0" } },
          },
          step_0: {
            entry: [
              { type: "code", function: "create_temp_doc" },
              { type: "code", function: "increment_counter" },
            ],
            on: { DONE: { target: "idle" } },
          },
        },
        documentTypes: {
          TempResult: {
            type: "object",
            properties: { result: { type: "string" } },
            required: ["result"],
          },
          Counter: {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
          },
        },
        functions: {
          cleanup_temp_docs: {
            type: "action",
            code: `export default function cleanup_temp_docs(context, event) {
              // Only delete temporary documents, preserve counter
              context.deleteDoc?.('temp-result');
            }`,
          },
          create_temp_doc: {
            type: "action",
            code: `export default function create_temp_doc(context, event) {
              context.createDoc?.({
                id: 'temp-result',
                type: 'TempResult',
                data: { result: 'processed' }
              });
            }`,
          },
          increment_counter: {
            type: "action",
            code: `export default function increment_counter(context, event) {
              const counter = context.documents.find(d => d.id === 'counter');
              if (counter) {
                context.updateDoc?.('counter', { count: counter.data.count + 1 });
              } else {
                context.createDoc?.({
                  id: 'counter',
                  type: 'Counter',
                  data: { count: 1 }
                });
              }
            }`,
          },
        },
      };

      const { engine } = await createTestEngine(fsm);

      // Run 1 - START signal: idle -> step_0
      await engine.signal({ type: "START" });
      assertEquals(engine.state, "step_0");
      assertEquals(engine.documents.length, 2); // temp-result, counter
      const counter1 = engine.documents.find((d) => d.id === "counter");
      assertEquals(counter1?.data.count, 1);

      // Complete run 1 - DONE signal: step_0 -> idle (cleanup runs)
      await engine.signal({ type: "DONE" });
      assertEquals(engine.state, "idle");
      assertEquals(engine.documents.length, 1); // Only counter remains
      const counterAfterCleanup = engine.documents.find((d) => d.id === "counter");
      assertEquals(counterAfterCleanup?.data.count, 1); // Counter preserved

      // Run 2 - START signal: idle -> step_0
      await engine.signal({ type: "START" });
      assertEquals(engine.state, "step_0");
      assertEquals(engine.documents.length, 2); // temp-result (new), counter
      const counter2 = engine.documents.find((d) => d.id === "counter");
      assertEquals(counter2?.data.count, 2); // Counter incremented!
    });
  });

  describe("Stateful Documents", () => {
    it("should persist stateful documents across runs", async () => {
      const fsm: FSMDefinition = {
        id: "stateful-docs",
        initial: "idle",
        states: {
          idle: {
            entry: [{ type: "code", function: "init_counter_if_missing" }],
            on: { START: { target: "step_0" } },
          },
          step_0: {
            entry: [
              { type: "code", function: "check_and_increment_counter" },
              { type: "emit", event: "DONE" },
            ],
            on: { DONE: { target: "idle" } },
          },
        },
        documentTypes: {
          Counter: {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
          },
        },
        functions: {
          init_counter_if_missing: {
            type: "action",
            code: `export default function init_counter_if_missing(context, event) {
              const counter = context.documents.find(d => d.id === 'counter');
              if (!counter) {
                context.createDoc?.({
                  id: 'counter',
                  type: 'Counter',
                  data: { count: 0 }
                });
              }
            }`,
          },
          check_and_increment_counter: {
            type: "action",
            code: `export default function check_and_increment_counter(context, event) {
              const counter = context.documents.find(d => d.id === 'counter');
              if (!counter) {
                throw new Error('Counter should exist!');
              }
              context.updateDoc?.('counter', { count: counter.data.count + 1 });
            }`,
          },
        },
      };

      const { engine } = await createTestEngine(fsm);

      // Run 1
      await engine.signal({ type: "START" });
      const counter1 = engine.documents.find((d) => d.id === "counter");
      assertEquals(counter1?.data.count, 1);

      // Run 2
      await engine.signal({ type: "START" });
      const counter2 = engine.documents.find((d) => d.id === "counter");
      assertEquals(counter2?.data.count, 2);

      // Run 3
      await engine.signal({ type: "START" });
      const counter3 = engine.documents.find((d) => d.id === "counter");
      assertEquals(counter3?.data.count, 3);
    });
  });

  describe("reset() runs idle entry actions", () => {
    it("should run idle state entry actions on reset()", async () => {
      const fsm: FSMDefinition = {
        id: "reset-entry-actions",
        initial: "idle",
        states: {
          idle: {
            entry: [
              { type: "code", function: "cleanup_all_docs" },
              { type: "emit", event: "cleanup_complete" },
            ],
            on: { START: { target: "step_0" } },
          },
          step_0: {
            entry: [{ type: "code", function: "create_docs" }],
            on: { DONE: { target: "idle" } },
          },
        },
        documentTypes: {
          TestDoc: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
        functions: {
          cleanup_all_docs: {
            type: "action",
            code: `export default function cleanup_all_docs(context, event) {
              // Delete all documents - safe to call even if already deleted
              const docIds = context.documents.map(d => d.id);
              for (const id of docIds) {
                context.deleteDoc?.(id);
              }
            }`,
          },
          create_docs: {
            type: "action",
            code: `export default function create_docs(context, event) {
              context.createDoc?.({
                id: 'doc1',
                type: 'TestDoc',
                data: { value: 'test' }
              });
              context.createDoc?.({
                id: 'doc2',
                type: 'TestDoc',
                data: { value: 'test2' }
              });
            }`,
          },
        },
      };

      const { engine } = await createTestEngine(fsm);

      // Create some documents
      await engine.signal({ type: "START" });
      assertEquals(engine.documents.length, 2);

      // Reset should run idle entry actions (cleanup)
      await engine.reset();

      // Should have cleanup_complete event and no documents
      const cleanupEvent = engine.emittedEvents.find((e) => e.event === "cleanup_complete");
      assertEquals(cleanupEvent?.event, "cleanup_complete");
      assertEquals(engine.documents.length, 0);
      assertEquals(engine.state, "idle");
    });

    it("should allow documents to be cleaned and recreated between runs", async () => {
      const fsm: FSMDefinition = {
        id: "clean-slate",
        initial: "idle",
        states: {
          idle: {
            entry: [{ type: "code", function: "delete_all_docs" }],
            on: { START: { target: "step_0" } },
          },
          step_0: {
            entry: [{ type: "code", function: "create_docs" }],
            on: { DONE: { target: "idle" } },
          },
        },
        documentTypes: {
          TestDoc: { type: "object", properties: { run: { type: "number" } }, required: ["run"] },
        },
        functions: {
          delete_all_docs: {
            type: "action",
            code: `export default function delete_all_docs(context, event) {
              const docIds = context.documents.map(d => d.id);
              for (const id of docIds) {
                context.deleteDoc?.(id);
              }
            }`,
          },
          create_docs: {
            type: "action",
            code: `export default function create_docs(context, event) {
              const counter = context.documents.find(d => d.id === 'run-counter');
              const runNum = counter ? counter.data.count + 1 : 1;

              context.createDoc?.({
                id: 'fresh-doc',
                type: 'TestDoc',
                data: { run: runNum }
              });

              // Track run number in a counter that survives
              if (counter) {
                context.updateDoc?.('run-counter', { count: runNum });
              } else {
                context.createDoc?.({
                  id: 'run-counter',
                  type: 'TestDoc',
                  data: { run: runNum }
                });
              }
            }`,
          },
        },
      };

      const { engine } = await createTestEngine(fsm);

      // Run 1 - transition to step_0, create docs, stay there
      await engine.signal({ type: "START" });
      assertEquals(engine.state, "step_0");
      const doc1 = engine.documents.find((d) => d.id === "fresh-doc");
      assertEquals(doc1?.data.run, 1);

      // Return to idle (will delete all docs)
      await engine.signal({ type: "DONE" });
      assertEquals(engine.state, "idle");
      assertEquals(engine.documents.length, 0); // All docs deleted

      // Run 2 - should create fresh documents again
      await engine.signal({ type: "START" });
      assertEquals(engine.state, "step_0");
      const doc2 = engine.documents.find((d) => d.id === "fresh-doc");
      assertEquals(doc2?.data.run, 1); // New document, fresh counter
    });
  });
});
