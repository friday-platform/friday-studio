/**
 * Validation harness for P2 scenarios. Doesn't spin up the daemon/browser —
 * each P2 scenario shells out to `deno task test` on an existing vitest file,
 * so we can drive `scenario.run()` directly with a fake ScenarioContext.
 */

import { describe, expect, it } from "vitest";
import type { BrowserController } from "../browser.ts";
import type { MockHandle } from "../mock.ts";
import { listScenarios, type ScenarioContext } from "../run-core.ts";
// Force registration side-effect once for this test file.
import "./p2.ts";

function fakeContext(): ScenarioContext {
  const mock: MockHandle = {
    url: "http://127.0.0.1:0",
    server: { url: "http://127.0.0.1:0", stop: () => Promise.resolve() },
  };
  const browser: BrowserController = {
    goto: () => Promise.resolve(),
    evaluate: <T>(): Promise<T> => Promise.resolve(undefined as T),
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

describe("p2 scenarios", () => {
  it("registers all five P2 scenarios on import", () => {
    const ids = listScenarios().map((s) => s.id);
    expect(ids).toEqual(["P2-01", "P2-02", "P2-03", "P2-04", "P2-05"]);
  });

  it.each([
    "P2-01",
    "P2-02",
    "P2-03",
    "P2-04",
    "P2-05",
  ])("%s scenario.run() resolves (underlying vitest passes)", async (id) => {
    const scenario = listScenarios().find((s) => s.id === id);
    expect(scenario).toBeDefined();
    // If the underlying vitest fails, run() throws with the captured output.
    await scenario!.run(fakeContext());
  }, 120_000);
});
