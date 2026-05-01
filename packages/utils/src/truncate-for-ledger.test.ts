import { describe, expect, it } from "vitest";
import { truncateForLedger } from "../mod.ts";

describe("truncateForLedger", () => {
  it("returns short strings unchanged", () => {
    expect(truncateForLedger("hello")).toBe("hello");
  });

  it("truncates long strings with ellipsis suffix at maxChars", () => {
    const long = "a".repeat(250);
    const out = truncateForLedger(long, 200);
    expect([...out].length).toBe(200);
    expect(out.endsWith("…")).toBe(true);
  });

  it("truncates at the provided maxChars when smaller than default", () => {
    const out = truncateForLedger("a".repeat(50), 10);
    expect([...out].length).toBe(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("JSON-stringifies plain objects and truncates when necessary", () => {
    expect(truncateForLedger({ ok: true, n: 2 })).toBe('{"ok":true,"n":2}');
    const big = { query: "x".repeat(400) };
    const out = truncateForLedger(big, 50);
    expect([...out].length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith('{"query":"')).toBe(true);
  });

  it("JSON-stringifies arrays", () => {
    expect(truncateForLedger([1, 2, 3])).toBe("[1,2,3]");
  });

  it("replaces Uint8Array nodes with [binary]", () => {
    expect(truncateForLedger(new Uint8Array([1, 2, 3]))).toBe('"[binary]"');
    expect(truncateForLedger({ data: new Uint8Array([9]) })).toBe('{"data":"[binary]"}');
  });

  it("replaces ReadableStream nodes with [stream]", () => {
    const stream = new ReadableStream({ start: (c) => c.close() });
    expect(truncateForLedger({ payload: stream })).toBe('{"payload":"[stream]"}');
  });

  it("replaces circular object references with [circular]", () => {
    const a: Record<string, unknown> = { name: "outer" };
    a.self = a;
    expect(truncateForLedger(a)).toBe('{"name":"outer","self":"[circular]"}');
  });

  it("replaces circular array references with [circular]", () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(truncateForLedger(arr)).toBe('[1,"[circular]"]');
  });

  it("returns [unserializable] without throwing when a getter throws", () => {
    const obj = {
      get boom() {
        throw new Error("nope");
      },
    };
    expect(truncateForLedger(obj)).toBe("[unserializable]");
  });

  it("returns [unserializable] without throwing on BigInt", () => {
    // BigInt is a primitive that JSON.stringify can't serialize — we should
    // swallow the TypeError rather than propagate it to the delegate.
    expect(truncateForLedger(123n)).toBe("[unserializable]");
  });
});
