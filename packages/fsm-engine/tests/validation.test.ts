import { assertRejects, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { FSMDefinition } from "../types.ts";
import { createTestEngine } from "./lib/test-utils.ts";

describe("FSM Engine - Validation", () => {
  it("should validate document updates against schema", async () => {
    const fsm: FSMDefinition = {
      id: "invalid-doc",
      initial: "start",
      states: {
        start: {
          documents: [{ id: "doc1", type: "test-doc", data: { val: 0 } }],
          on: { UPDATE: { target: "start", actions: [{ type: "code", function: "updateBad" }] } },
        },
      },
      functions: {
        updateBad: {
          type: "action",
          code: `
            export default (ctx, e) => {
              ctx.updateDoc('doc1', { val: 'not-a-number' });
            }
          `,
        },
      },
      documentTypes: { "test-doc": { type: "object", properties: { val: { type: "number" } } } },
    };

    const { engine } = await createTestEngine(fsm);

    const error = await assertRejects(async () => await engine.signal({ type: "UPDATE" }));

    assertStringIncludes(String(error), 'Document "doc1" of type "test-doc" failed validation');
    assertStringIncludes(String(error), "expected number, received string");
  });
});
