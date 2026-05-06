/**
 * Unit tests for the small helpers in `migrate.ts`:
 *   - loadFridayEnv: reads `<friday_home>/.env` into process.env.
 *   - isDaemonRunning: cheap port-aware probe of the daemon's /health.
 *
 * Handler-level behavior (relocate-before-connect, --json failure mode,
 * exit codes) lives in `migrate-handler.test.ts`. The relocation helper
 * itself is covered by `relocate-jetstream-store.test.ts`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDaemonRunning, loadFridayEnv } from "./migrate.ts";

let fixtureHome: string;
let savedPortEnv: string | undefined;

beforeEach(async () => {
  fixtureHome = await mkdtemp(join(tmpdir(), "atlas-migrate-test-"));
  savedPortEnv = process.env.FRIDAY_PORT_FRIDAY;
  delete process.env.FRIDAY_PORT_FRIDAY;
});

afterEach(async () => {
  await rm(fixtureHome, { recursive: true, force: true }).catch(() => {});
  if (savedPortEnv === undefined) {
    delete process.env.FRIDAY_PORT_FRIDAY;
  } else {
    process.env.FRIDAY_PORT_FRIDAY = savedPortEnv;
  }
});

describe("loadFridayEnv", () => {
  it("loads FRIDAY_PORT_FRIDAY into process.env from <friday_home>/.env", async () => {
    await writeFile(join(fixtureHome, ".env"), "FRIDAY_PORT_FRIDAY=18080\n");
    await loadFridayEnv(fixtureHome);
    expect(process.env.FRIDAY_PORT_FRIDAY).toBe("18080");
  });

  it("is a no-op when .env doesn't exist", async () => {
    await expect(loadFridayEnv(fixtureHome)).resolves.toBeUndefined();
    expect(process.env.FRIDAY_PORT_FRIDAY).toBeUndefined();
  });

  it("does not crash when <friday_home> directory itself is missing", async () => {
    const ghost = join(fixtureHome, "does-not-exist");
    await expect(loadFridayEnv(ghost)).resolves.toBeUndefined();
  });
});

/** Spin a small HTTP server on `port` returning 200 on `/health`. */
async function startStubDaemon(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe("isDaemonRunning", () => {
  it("returns false when nothing is listening on the configured port", async () => {
    process.env.FRIDAY_PORT_FRIDAY = "59999"; // unused
    expect(await isDaemonRunning()).toBe(false);
  });

  it("respects FRIDAY_PORT_FRIDAY rather than the legacy 8080", async () => {
    const port = 18181;
    process.env.FRIDAY_PORT_FRIDAY = String(port);
    const server = await startStubDaemon(port);
    try {
      expect(await isDaemonRunning()).toBe(true);
    } finally {
      await stopServer(server);
    }
  });
});
