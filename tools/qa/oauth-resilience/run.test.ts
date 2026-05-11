import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserController } from "./browser.ts";
import type { MockHandle } from "./mock.ts";
import {
  filterScenarios,
  listScenarios,
  parseArgs,
  register,
  resetRegistry,
  runScenario,
  type Scenario,
  type ScenarioContext,
} from "./run-core.ts";

function coerceUnknown<T>(value: unknown): T {
  return value as T;
}

function fakeContext(): ScenarioContext {
  const mock: MockHandle = {
    url: "http://127.0.0.1:0",
    server: { url: "http://127.0.0.1:0", stop: () => Promise.resolve() },
  };
  const browser: BrowserController = {
    goto: () => Promise.resolve(),
    evaluate: <T>(): Promise<T> => Promise.resolve(coerceUnknown<T>(undefined)),
    waitFor: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return {
    mock,
    daemon: {
      port: 0,
      baseUrl: "http://127.0.0.1:0",
      fridayHome: "/tmp/fake",
      natsUrl: "nats://127.0.0.1:0",
    },
    browser,
  };
}

describe("parseArgs", () => {
  it("defaults to no filter, no fail-fast, no verbose, no list", () => {
    expect(parseArgs([])).toEqual({ failFast: false, verbose: false, list: false });
  });

  it("parses --filter with a separate argument", () => {
    expect(parseArgs(["--filter", "P1-"])).toEqual({
      filter: "P1-",
      failFast: false,
      verbose: false,
      list: false,
    });
  });

  it("parses --filter= attached", () => {
    expect(parseArgs(["--filter=P3-"]).filter).toEqual("P3-");
  });

  it("recognises --fail-fast, --verbose, --list", () => {
    const parsed = parseArgs(["--fail-fast", "--verbose", "--list"]);
    expect(parsed.failFast).toEqual(true);
    expect(parsed.verbose).toEqual(true);
    expect(parsed.list).toEqual(true);
  });

  it("recognises the -v shorthand", () => {
    expect(parseArgs(["-v"]).verbose).toEqual(true);
  });

  it("--help short-circuits to list mode", () => {
    expect(parseArgs(["--help"]).list).toEqual(true);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--surprise"])).toThrow(/unknown flag/);
  });

  it("rejects --filter without a value", () => {
    expect(() => parseArgs(["--filter"])).toThrow(/requires a value/);
  });
});

describe("scenario registry", () => {
  beforeEach(() => resetRegistry());
  afterEach(() => resetRegistry());

  it("preserves registration order", () => {
    register({ id: "P1-02", description: "second", run: async () => {} });
    register({ id: "P1-01", description: "first", run: async () => {} });
    const ids = listScenarios().map((s) => s.id);
    expect(ids).toEqual(["P1-02", "P1-01"]);
  });

  it("rejects duplicate ids", () => {
    register({ id: "P1-01", description: "first", run: async () => {} });
    expect(() => register({ id: "P1-01", description: "again", run: async () => {} })).toThrow(
      /already registered/,
    );
  });
});

describe("filterScenarios", () => {
  const scenarios: Scenario[] = [
    { id: "P1-01", description: "a", run: async () => {} },
    { id: "P1-02", description: "b", run: async () => {} },
    { id: "P3-05", description: "c", run: async () => {} },
  ];

  it("returns everything when filter is empty/undefined", () => {
    expect(filterScenarios(scenarios, undefined).length).toEqual(3);
    expect(filterScenarios(scenarios, "").length).toEqual(3);
  });

  it("matches by substring", () => {
    expect(filterScenarios(scenarios, "P1-").length).toEqual(2);
    expect(filterScenarios(scenarios, "01").map((s) => s.id)).toEqual(["P1-01"]);
  });
});

describe("runScenario", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Stub fetch so the per-scenario mockControl reset is a no-op.
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
      );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns passed when the scenario body resolves", async () => {
    const scenario: Scenario = { id: "P1-01", description: "ok", run: async () => {} };
    const result = await runScenario(scenario, fakeContext());
    expect(result.status).toEqual("passed");
    expect(result.id).toEqual("P1-01");
  });

  it("returns failed and captures the error message when the body throws", async () => {
    const scenario: Scenario = {
      id: "P1-02",
      description: "boom",
      run: () => Promise.reject(new Error("nope")),
    };
    const result = await runScenario(scenario, fakeContext());
    expect(result.status).toEqual("failed");
    expect(result.error ?? "").toContain("nope");
  });

  it("forwards verbose lifecycle lines to the supplied logger", async () => {
    const lines: string[] = [];
    await runScenario({ id: "P1-03", description: "log", run: async () => {} }, fakeContext(), {
      verbose: true,
      logger: { log: (line) => lines.push(line) },
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("P1-03");
  });
});
