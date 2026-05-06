/**
 * Tests for the `record_validation` platform tool factory. Phase B6 of
 * melodic-strolling-seal-pt2.
 *
 * The factory is a re-export from `@atlas/core/agent-context/record-validation-tool`;
 * tests live here to keep coverage paired with the platform-tools catalog
 * directory (where any new platform tool's test would land). The canonical
 * implementation is exercised end-to-end in fsm-engine's
 * `validation-emit.test.ts` — these tests cover the tool's static surface.
 */

import { describe, expect, test } from "vitest";
import {
  createRecordValidationTool,
  RECORD_VALIDATION_TOOL_NAME,
  type RecordValidationInput,
} from "./record-validation.ts";

describe("record_validation platform tool", () => {
  test("exposes the canonical name", () => {
    expect(RECORD_VALIDATION_TOOL_NAME).toBe("record_validation");
  });

  test("createRecordValidationTool returns a Tool with description and inputSchema", () => {
    const tool = createRecordValidationTool();
    expect(typeof tool.description).toBe("string");
    expect(tool.description?.length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBeDefined();
  });

  test("inputSchema accepts a minimal pass verdict", () => {
    const tool = createRecordValidationTool();
    // The Zod schema is on inputSchema; safeParse it directly.
    const input: RecordValidationInput = { verdict: "pass" };
    const schema = tool.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    const result = schema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("inputSchema accepts advisory verdict with issues", () => {
    const tool = createRecordValidationTool();
    const input = {
      verdict: "advisory",
      issues: [
        {
          claim: "the API returned 5 users",
          category: "sourcing",
          reasoning: "tool result showed 4",
          severity: "warn",
        },
      ],
    };
    const schema = tool.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse(input).success).toBe(true);
  });

  test("inputSchema accepts blocking verdict with multiple issues", () => {
    const tool = createRecordValidationTool();
    const input = {
      verdict: "blocking",
      issues: [
        { claim: "no tools called but data claimed", category: "no-tools-called" },
        { claim: "second unsourced claim", citation: null },
      ],
    };
    const schema = tool.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse(input).success).toBe(true);
  });

  test("inputSchema rejects malformed verdicts", () => {
    const tool = createRecordValidationTool();
    const schema = tool.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ verdict: "looks-pass" }).success).toBe(false);
    expect(schema.safeParse({ verdict: "PASS" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  test("inputSchema rejects an issue without a claim", () => {
    const tool = createRecordValidationTool();
    const schema = tool.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    const result = schema.safeParse({ verdict: "advisory", issues: [{ category: "sourcing" }] });
    expect(result.success).toBe(false);
  });

  test("execute is a no-op acknowledgement (verdict is captured via toolCalls)", async () => {
    const tool = createRecordValidationTool();
    if (typeof tool.execute !== "function") {
      throw new Error("expected tool.execute to be a function");
    }
    // Cast the exec function loosely — we don't care about the typed
    // ToolCallOptions shape here, only that the body is invocable.
    const out = await (tool.execute as (input: unknown, opts: unknown) => unknown)(
      { verdict: "pass" },
      {},
    );
    expect(out).toEqual({ recorded: true });
  });
});
