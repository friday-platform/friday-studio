import { describe, expect, it } from "vitest";
import type { Context } from "../types.ts";
import { WorkerExecutor } from "../worker-executor.ts";

// These tests require Deno's Worker API with permissions sandbox
const isDenoRuntime = typeof (globalThis as Record<string, unknown>).Deno !== "undefined";

const mockContext: Context = {
  documents: [{ id: "doc1", type: "test", data: { value: 42 } }],
  state: "active",
  results: {},
};

const mockSignal = { type: "TEST", data: { foo: "bar" } };

describe.skipIf(!isDenoRuntime)("WorkerExecutor - Basic", () => {
  it("guard returns true", async () => {
    const executor = new WorkerExecutor({ timeout: 5000, functionType: "guard" });
    const code = "export default () => true";
    const result = await executor.execute(code, "alwaysTrue", mockContext, mockSignal);
    expect(result).toEqual(true);
  });

  it("guard returns false", async () => {
    const executor = new WorkerExecutor({ timeout: 5000, functionType: "guard" });
    const code = "export default () => false";
    const result = await executor.execute(code, "alwaysFalse", mockContext, mockSignal);
    expect(result).toEqual(false);
  });

  it("guard reads context.documents", async () => {
    const executor = new WorkerExecutor({ timeout: 5000, functionType: "guard" });
    const code = "export default (ctx) => ctx.documents.length > 0";
    const result = await executor.execute(code, "hasDocuments", mockContext, mockSignal);
    expect(result).toEqual(true);
  });

  it("guard reads event.data", async () => {
    const executor = new WorkerExecutor({ timeout: 5000, functionType: "guard" });
    const code = "export default (ctx, event) => event.data.foo === 'bar'";
    const result = await executor.execute(code, "checkEventData", mockContext, mockSignal);
    expect(result).toEqual(true);
  });

  it("timeout throws", async () => {
    const executor = new WorkerExecutor({ timeout: 100, functionType: "guard" });
    const code = "export default () => { while(true) {} }";
    await expect(executor.execute(code, "infinite", mockContext, mockSignal)).rejects.toThrow(
      "timed out",
    );
  });

  it("syntax error throws", async () => {
    const executor = new WorkerExecutor({ timeout: 5000, functionType: "guard" });
    const code = "export default () => {{{";
    await expect(executor.execute(code, "badSyntax", mockContext, mockSignal)).rejects.toThrow();
  });

  it("runtime error throws", async () => {
    const executor = new WorkerExecutor({ timeout: 5000, functionType: "action" });
    const code = "export default () => { throw new Error('boom'); }";
    await expect(executor.execute(code, "throws", mockContext, mockSignal)).rejects.toThrow("boom");
  });

  it("action returns undefined", async () => {
    const executor = new WorkerExecutor({ timeout: 5000, functionType: "action" });
    const code = "export default () => {}";
    const result = await executor.execute(code, "noop", mockContext, mockSignal);
    expect(result).toEqual(undefined);
  });

  it("action return value is propagated", async () => {
    const executor = new WorkerExecutor({ timeout: 5000, functionType: "action" });
    const code = `export default () => ({ task: "Do it", config: { model: "gpt-4" } })`;
    const result = await executor.execute(code, "prepare", mockContext, mockSignal);
    expect(result).toMatchObject({ task: "Do it", config: { model: "gpt-4" } });
  });
});

describe.skipIf(!isDenoRuntime)("WorkerExecutor - Async Code", () => {
  it("async action is awaited", async () => {
    const executor = new WorkerExecutor({ timeout: 5000, functionType: "action" });

    const ops: string[] = [];
    const ctx: Context = {
      documents: [{ id: "x", type: "test", data: { step: 0 } }],
      state: "test",
      results: {},
      updateDoc: (id: string, data: Record<string, unknown>) =>
        ops.push(`update:${id}:${JSON.stringify(data)}`),
    };

    // This async function does work after a "delay"
    const code = `export default async (context) => {
      context.updateDoc('x', { step: 1 });
      await Promise.resolve(); // Simulates async work
      context.updateDoc('x', { step: 2 });
    }`;

    await executor.execute(code, "asyncAction", ctx, { type: "TEST" });

    // BOTH mutations should be captured (not just the first one)
    expect(ops.length).toEqual(2);
    expect(ops[0]).toEqual('update:x:{"step":1}');
    expect(ops[1]).toEqual('update:x:{"step":2}');
  });

  it("async guard returns promise result", async () => {
    const executor = new WorkerExecutor({ timeout: 5000, functionType: "guard" });
    const code = "export default async () => { await Promise.resolve(); return true; }";
    const result = await executor.execute(code, "asyncGuard", mockContext, mockSignal);
    expect(result).toEqual(true);
  });
});

describe.skipIf(!isDenoRuntime)("WorkerExecutor - Security Isolation", () => {
  const executor = new WorkerExecutor({ timeout: 5000, functionType: "action" });
  const ctx: Context = { documents: [], state: "test", results: {} };
  const sig = { type: "TEST" };

  it("cannot read filesystem", async () => {
    const code = "export default async () => await Deno.readTextFile('/etc/passwd')";
    await expect(executor.execute(code, "readFile", ctx, sig)).rejects.toThrow();
  });

  it("cannot write filesystem", async () => {
    const code = "export default async () => await Deno.writeTextFile('/tmp/hack.txt', 'pwned')";
    await expect(executor.execute(code, "writeFile", ctx, sig)).rejects.toThrow();
  });

  it("cannot make network requests", async () => {
    const code = "export default async () => await fetch('https://example.com')";
    await expect(executor.execute(code, "fetch", ctx, sig)).rejects.toThrow();
  });

  it("cannot spawn processes", async () => {
    const code =
      "export default async () => { const cmd = new Deno.Command('ls'); await cmd.output(); }";
    await expect(executor.execute(code, "exec", ctx, sig)).rejects.toThrow();
  });

  it("cannot access environment variables", async () => {
    const code = "export default () => Deno.env.get('HOME')";
    await expect(executor.execute(code, "env", ctx, sig)).rejects.toThrow();
  });

  it("cannot import external modules", async () => {
    const code = "export default async () => await import('https://deno.land/std/fs/mod.ts')";
    await expect(executor.execute(code, "import", ctx, sig)).rejects.toThrow();
  });
});
