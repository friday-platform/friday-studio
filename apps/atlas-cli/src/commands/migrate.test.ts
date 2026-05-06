/**
 * Tests for `apps/atlas-cli/src/commands/migrate.ts`.
 *
 * Focus: the new behavior introduced by Stream B of the JetStream store
 * migration plan — `.env` load on handler entry, port-aware daemon-alive
 * probe, and the pre-NATS / post-NATS sequencing contract. The
 * pre-NATS registry semantics themselves are covered in
 * `../pre-nats-migrations/*.test.ts`; here we exercise the integration.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    // No .env in fixtureHome.
    await expect(loadFridayEnv(fixtureHome)).resolves.toBeUndefined();
    expect(process.env.FRIDAY_PORT_FRIDAY).toBeUndefined();
  });

  it("does not crash when <friday_home> directory itself is missing", async () => {
    const ghost = join(fixtureHome, "does-not-exist");
    await expect(loadFridayEnv(ghost)).resolves.toBeUndefined();
  });
});

/**
 * Spin a small HTTP server on `port` that returns 200 on `/health`. Used
 * to verify the port-aware daemon-alive probe.
 */
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
    // Pick an unlikely port to avoid colliding with anything real on the
    // dev's machine.
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

describe("pre-NATS / post-NATS sequencing", () => {
  it("preNatsMigrations registry includes relocate-jetstream-store", async () => {
    const { preNatsMigrations } = await import("../pre-nats-migrations/index.ts");
    expect(preNatsMigrations.some((m) => m.id === "relocate-jetstream-store")).toBe(true);
  });

  it("first-failure-aborts-queue: throwing entry stops execution before later entries", async () => {
    // Verifies the contract documented in the v6 plan:
    // "first failure stops the pre-NATS queue AND prevents post-NATS
    //  execution (`connectOrSpawn` is not called)."
    const { runPreNatsMigrations } = await import("../pre-nats-migrations/index.ts");
    const { logger } = await import("@atlas/logger");

    const calls: string[] = [];
    const result = await runPreNatsMigrations(logger, { dryRun: false }, [
      {
        id: "succeed-then",
        name: "succeed-then",
        description: "first stub: succeed",
        run: async () => {
          await Promise.resolve();
          calls.push("succeed-then");
          return {
            id: "succeed-then",
            status: "noop",
            legacy_path: "",
            target_path: "",
            target_source: "default",
            duration_ms: 0,
          };
        },
      },
      {
        id: "throw-here",
        name: "throw-here",
        description: "second stub: throws",
        run: async () => {
          await Promise.resolve();
          calls.push("throw-here");
          throw new Error("simulated failure");
        },
      },
      {
        id: "never-runs",
        name: "never-runs",
        description: "third stub: should be unreachable",
        run: async () => {
          await Promise.resolve();
          calls.push("never-runs");
          return {
            id: "never-runs",
            status: "noop",
            legacy_path: "",
            target_path: "",
            target_source: "default",
            duration_ms: 0,
          };
        },
      },
    ]);

    expect(calls).toEqual(["succeed-then", "throw-here"]);
    expect(result.aborted).toBe(true);
    // The handler reads `aborted` and skips connectOrSpawn — we don't
    // call connectOrSpawn here directly, but the contract is enforced
    // at the handler level by the early return in the aborted branch.
  });
});

describe("--list output includes pre-NATS entries", () => {
  it("listPreNatsEntries returns at least the relocate-store entry", async () => {
    const { listPreNatsEntries } = await import("../pre-nats-migrations/index.ts");
    const entries = listPreNatsEntries();
    expect(entries.find((e) => e.id === "relocate-jetstream-store")).toBeTruthy();
  });
});

describe("dry-run does not mutate the filesystem", () => {
  it("relocate-store reports migrated without removing legacy data in dry-run", async () => {
    const { runRelocate } = await import("../pre-nats-migrations/relocate-store.ts");
    const { logger } = await import("@atlas/logger");

    const legacy = join(fixtureHome, "legacy");
    const target = join(fixtureHome, "target");
    await mkdir(join(legacy, "jetstream", "$G", "streams", "X"), { recursive: true });
    await writeFile(join(legacy, "jetstream", "$G", "streams", "X", "meta.inf"), "x");

    const outcome = await runRelocate(
      { logger, dryRun: true },
      { legacyPath: legacy, targetPath: target, targetSource: "default" },
    );

    expect(outcome.status).toBe("migrated");
    // Source directory still on disk after dry-run.
    const { stat } = await import("node:fs/promises");
    await expect(stat(legacy)).resolves.toBeTruthy();
  });
});
