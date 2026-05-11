/**
 * Unit tests for the mock wrapper. We stub the mock server's HTTP surface
 * with a small Node http server so the tests work under vitest (where the
 * `Deno` global is unavailable). The full Deno-backed mock server is
 * exercised end-to-end by the runner itself, not by these tests.
 */

import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MockHandle } from "./mock.ts";
import { mockControl, mockCounts } from "./mock.ts";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModeBody(text: string): { mode: string; payload?: unknown } {
  const parsed: unknown = JSON.parse(text);
  if (!isPlainRecord(parsed)) throw new Error("control body must be an object");
  const mode = parsed.mode;
  if (typeof mode !== "string") throw new Error("control body must contain mode string");
  return { mode, payload: parsed.payload };
}

function portOf(address: ReturnType<Server["address"]>): number {
  if (address === null || typeof address === "string") throw new Error("server bind failed");
  // node:net AddressInfo — narrowed via discriminating fields rather than a cast.
  const candidate: AddressInfo = address;
  return candidate.port;
}

interface FakeState {
  mode: string;
  payload: unknown;
  resetCalls: number;
  modeCalls: Array<{ mode: string; payload: unknown }>;
  /**
   * What the stub returns for /control/counts. Typed loose so individual
   * tests can inject malformed bodies to exercise the parser.
   */
  countsResponse: unknown;
  countsRequests: number;
}

interface FakeServer {
  url: string;
  state: FakeState;
  stop: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function startFakeMock(): Promise<FakeServer> {
  const state: FakeState = {
    mode: "success",
    payload: undefined,
    resetCalls: 0,
    modeCalls: [],
    countsResponse: { total: 0, byMode: {}, flakyCallCount: 0 },
    countsRequests: 0,
  };

  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    if (req.url === "/control/reset") {
      state.resetCalls += 1;
      state.mode = "success";
      state.payload = undefined;
      state.countsResponse = { total: 0, byMode: {}, flakyCallCount: 0 };
      json(res, 200, { ok: true });
      return;
    }
    if (req.url === "/control/mode") {
      const bodyText = await readBody(req);
      const parsed = parseModeBody(bodyText);
      state.modeCalls.push({ mode: parsed.mode, payload: parsed.payload });
      state.mode = parsed.mode;
      state.payload = parsed.payload;
      json(res, 200, { ok: true, mode: state.mode });
      return;
    }
    if (req.url === "/control/counts") {
      state.countsRequests += 1;
      json(res, 200, state.countsResponse);
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${portOf(server.address())}`;

  return {
    url,
    state,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function asHandle(server: FakeServer): MockHandle {
  return { url: server.url, server: { url: server.url, stop: async () => {} } };
}

describe("oauth-resilience mock wrapper", () => {
  let fake: FakeServer;

  beforeEach(async () => {
    fake = await startFakeMock();
  });

  afterEach(async () => {
    await fake.stop();
  });

  it("mockControl({mode}) POSTs the mode to /control/mode", async () => {
    await mockControl(asHandle(fake), { mode: "invalid_grant" });
    expect(fake.state.modeCalls).toEqual([{ mode: "invalid_grant", payload: undefined }]);
    expect(fake.state.resetCalls).toEqual(0);
  });

  it("mockControl({mode, payload}) forwards the payload", async () => {
    await mockControl(asHandle(fake), { mode: "flaky", payload: "success" });
    expect(fake.state.modeCalls).toEqual([{ mode: "flaky", payload: "success" }]);
  });

  it("mockControl({resetCounts:true}) hits /control/reset before /control/mode", async () => {
    await mockControl(asHandle(fake), { resetCounts: true, mode: "http_500_text" });
    expect(fake.state.resetCalls).toEqual(1);
    expect(fake.state.modeCalls).toEqual([{ mode: "http_500_text", payload: undefined }]);
  });

  it("mockControl({resetCounts:true}) without mode only resets", async () => {
    await mockControl(asHandle(fake), { resetCounts: true });
    expect(fake.state.resetCalls).toEqual(1);
    expect(fake.state.modeCalls).toEqual([]);
  });

  it("mockCounts returns the parsed body", async () => {
    fake.state.countsResponse = {
      total: 5,
      byMode: { success: 4, invalid_grant: 1 },
      flakyCallCount: 0,
    };
    const counts = await mockCounts(asHandle(fake));
    expect(counts.total).toEqual(5);
    expect(counts.byMode.invalid_grant).toEqual(1);
  });

  it("mockCounts throws when the server returns non-object body", async () => {
    fake.state.countsResponse = null;
    await expect(mockCounts(asHandle(fake))).rejects.toThrow();
  });

  it("mockControl surfaces a non-2xx error with status + body", async () => {
    const handle: MockHandle = {
      url: "http://127.0.0.1:1",
      server: { url: "http://127.0.0.1:1", stop: async () => {} },
    };
    await expect(mockControl(handle, { mode: "success" })).rejects.toThrow();
  });
});
