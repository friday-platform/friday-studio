import { afterEach, describe, expect, it } from "vitest";
import { ValidationExecutor } from "./validation-executor.ts";

describe.skipIf(!("Deno" in globalThis))("ValidationExecutor", () => {
  let executor: ValidationExecutor;

  afterEach(() => {
    executor?.dispose();
  });

  it("evaluates a successful expression", async () => {
    executor = new ValidationExecutor();
    const result = await executor.execute({ expression: "value * 2", mockValue: 21, mockDocs: {} });
    expect(result).toEqual({ success: true, result: 42 });
  });

  it("provides docs binding for cross-document access", async () => {
    executor = new ValidationExecutor();
    const result = await executor.execute({
      expression: "value.amount * docs['tax'].rate",
      mockValue: { amount: 100 },
      mockDocs: { tax: { rate: 0.08 } },
    });
    expect.assert(result.success === true);
    expect(result.result).toBeCloseTo(8);
  });

  it("returns error for expressions that throw", async () => {
    executor = new ValidationExecutor();
    const result = await executor.execute({
      expression: "value.nonexistent.deep",
      mockValue: null,
      mockDocs: {},
    });
    expect.assert(result.success === false);
    expect(result.error).toBeTruthy();
  });

  it("returns error on timeout", async () => {
    executor = new ValidationExecutor();
    const result = await executor.execute({
      expression: "(() => { while(true) {} })()",
      mockValue: null,
      mockDocs: {},
      timeout: 100,
    });
    expect.assert(result.success === false);
    expect(result.error).toContain("Timeout");
  }, 10_000);

  it("processes concurrent calls sequentially in order", async () => {
    executor = new ValidationExecutor();

    const results = await Promise.all([
      executor.execute({ expression: "'first'", mockValue: null, mockDocs: {} }),
      executor.execute({ expression: "'second'", mockValue: null, mockDocs: {} }),
      executor.execute({ expression: "'third'", mockValue: null, mockDocs: {} }),
    ]);

    expect(results).toEqual([
      { success: true, result: "first" },
      { success: true, result: "second" },
      { success: true, result: "third" },
    ]);
  });

  it("returns error after dispose()", async () => {
    executor = new ValidationExecutor();
    executor.dispose();

    const result = await executor.execute({ expression: "1 + 1", mockValue: null, mockDocs: {} });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("disposed") });
  });
});
