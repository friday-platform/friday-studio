import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertCounterIncremented,
  findSamples,
  type MetricSample,
  parsePrometheus,
  readCredential,
  readMetrics,
  sumCounter,
  tamperCredential,
} from "./harness.ts";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portOf(address: ReturnType<Server["address"]>): number {
  if (address === null || typeof address === "string") throw new Error("server bind failed");
  const candidate: AddressInfo = address;
  return candidate.port;
}

interface StubServerHandle {
  baseUrl: string;
  stop: () => Promise<void>;
  /** Mutated by the test to control what `GET .../credentials/...` returns. */
  state: StubState;
  /** Captured PATCH bodies — used to assert tamperCredential's merge logic. */
  patches: Array<{ id: string; body: unknown }>;
  /** Snapshot of `/metrics` text. */
  metricsText: { value: string };
}

interface StubState {
  credentials: Array<{
    id: string;
    type: "oauth" | "apikey";
    provider: string;
    userIdentifier: string;
    secret: Record<string, unknown>;
  }>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function startStubLink(): Promise<StubServerHandle> {
  const state: StubState = { credentials: [] };
  const patches: Array<{ id: string; body: unknown }> = [];
  const metricsText = { value: "" };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/metrics" && method === "GET") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end(metricsText.value);
      return;
    }
    if (path === "/v1/credentials/type/oauth" && method === "GET") {
      const list = state.credentials.map(({ secret: _, ...rest }) => rest);
      sendJson(res, 200, list);
      return;
    }
    const internalMatch = path.match(/^\/internal\/v1\/credentials\/(.+)$/);
    if (internalMatch && method === "GET") {
      const id = decodeURIComponent(internalMatch[1] ?? "");
      const cred = state.credentials.find((c) => c.id === id);
      if (!cred) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      sendJson(res, 200, cred);
      return;
    }
    const patchMatch = path.match(/^\/v1\/credentials\/(.+)$/);
    if (patchMatch && method === "PATCH") {
      const id = decodeURIComponent(patchMatch[1] ?? "");
      const cred = state.credentials.find((c) => c.id === id);
      if (!cred) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const body: unknown = JSON.parse(await readBody(req));
      patches.push({ id, body });
      if (isPlainRecord(body)) {
        const next = body.secret;
        if (isPlainRecord(next)) {
          cred.secret = next;
        }
      }
      const { secret: _, ...summary } = cred;
      sendJson(res, 200, summary);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = portOf(server.address());

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    patches,
    metricsText,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("parsePrometheus", () => {
  it("parses bare counters", () => {
    const samples = parsePrometheus("link_total 4");
    expect(samples).toEqual([{ name: "link_total", labels: {}, value: 4 }]);
  });

  it("parses single-label counters", () => {
    const samples = parsePrometheus(`link_outcome{kind="transient"} 2`);
    expect(samples).toEqual([{ name: "link_outcome", labels: { kind: "transient" }, value: 2 }]);
  });

  it("parses multi-label counters", () => {
    const samples = parsePrometheus(`link_outcome{kind="transient",reason="network"} 7`);
    expect(samples[0]?.labels).toEqual({ kind: "transient", reason: "network" });
    expect(samples[0]?.value).toEqual(7);
  });

  it("skips HELP/TYPE comments and blank lines", () => {
    const samples = parsePrometheus(
      [
        "# HELP link_outcome how things went",
        "# TYPE link_outcome counter",
        "",
        "link_outcome 9",
      ].join("\n"),
    );
    expect(samples).toEqual([{ name: "link_outcome", labels: {}, value: 9 }]);
  });

  it("ignores malformed lines instead of throwing", () => {
    const samples = parsePrometheus("garbage line with no value\nlink_total 1\n");
    expect(samples).toEqual([{ name: "link_total", labels: {}, value: 1 }]);
  });
});

describe("findSamples + sumCounter", () => {
  const samples: MetricSample[] = [
    { name: "ctr", labels: { kind: "a" }, value: 1 },
    { name: "ctr", labels: { kind: "b" }, value: 2 },
    { name: "ctr", labels: { kind: "a", phase: "x" }, value: 4 },
    { name: "other", labels: {}, value: 10 },
  ];

  it("findSamples filters by exact name and label subset", () => {
    expect(findSamples(samples, "ctr", { kind: "a" }).length).toEqual(2);
  });

  it("sumCounter aggregates all matching samples", () => {
    expect(sumCounter(samples, "ctr", { kind: "a" })).toEqual(5);
    expect(sumCounter(samples, "ctr")).toEqual(7);
    expect(sumCounter(samples, "missing")).toEqual(0);
  });
});

describe("assertCounterIncremented", () => {
  const before: MetricSample[] = [{ name: "c", labels: {}, value: 3 }];
  const after: MetricSample[] = [{ name: "c", labels: {}, value: 5 }];

  it("returns the delta when the move meets the threshold", () => {
    expect(assertCounterIncremented(before, after, "c")).toEqual(2);
    expect(assertCounterIncremented(before, after, "c", { by: 2 })).toEqual(2);
  });

  it("throws when the move is below the threshold", () => {
    expect(() => assertCounterIncremented(before, after, "c", { by: 3 })).toThrow(
      /expected to increase by ≥3/,
    );
  });

  it("throws with a clear label string when filters are applied", () => {
    const labelBefore: MetricSample[] = [{ name: "c", labels: { kind: "x" }, value: 2 }];
    expect(() =>
      assertCounterIncremented(labelBefore, labelBefore, "c", { labelMatch: { kind: "x" } }),
    ).toThrow(/c\{kind="x"\}/);
  });
});

describe("harness HTTP layer", () => {
  let stub: StubServerHandle;

  beforeEach(async () => {
    stub = await startStubLink();
    stub.state.credentials.push({
      id: "oauth:google-calendar:test-user",
      type: "oauth",
      provider: "google-calendar",
      userIdentifier: "test-user",
      secret: { access_token: "old", refresh_token: "r", expires_at: 99 },
    });
    stub.metricsText.value =
      '# HELP link_oauth_refresh_total\n# TYPE link_oauth_refresh_total counter\nlink_oauth_refresh_total 5\nlink_oauth_refresh_total{kind="transient"} 3\n';
  });

  afterEach(async () => {
    await stub.stop();
  });

  it("readCredential surfaces the secret as parsed JSON", async () => {
    const cred = await readCredential("google-calendar", { linkBaseUrl: stub.baseUrl });
    expect(cred.id).toEqual("oauth:google-calendar:test-user");
    expect(cred.secret.access_token).toEqual("old");
    expect(cred.secret.expires_at).toEqual(99);
  });

  it("tamperCredential merges patch into existing secret", async () => {
    await tamperCredential("google-calendar", { expires_at: 1234 }, { linkBaseUrl: stub.baseUrl });
    expect(stub.patches.length).toEqual(1);
    const patch = stub.patches[0];
    if (!patch) throw new Error("expected at least one patch");
    const patchBody = patch.body;
    if (!isPlainRecord(patchBody)) throw new Error("patch body was not a record");
    expect(patchBody.secret).toEqual({ access_token: "old", refresh_token: "r", expires_at: 1234 });
  });

  it("readMetrics returns parsed samples", async () => {
    const samples = await readMetrics({ linkBaseUrl: stub.baseUrl });
    expect(sumCounter(samples, "link_oauth_refresh_total")).toEqual(8);
    expect(sumCounter(samples, "link_oauth_refresh_total", { kind: "transient" })).toEqual(3);
  });
});
