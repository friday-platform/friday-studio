import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalPathResolver } from "./local-path.ts";

const resolver = createLocalPathResolver();

describe("local-path resolver matches", () => {
  it("matches absolute paths", () => {
    expect(resolver.matches("/usr/local/bin/my-server", [])).toEqual({
      ref: "/usr/local/bin/my-server",
    });
  });

  it("matches relative paths", () => {
    expect(resolver.matches("./bin/server", [])).toEqual({ ref: "./bin/server" });
    expect(resolver.matches("../sibling/cli", [])).toEqual({ ref: "../sibling/cli" });
  });

  it("ignores bare binaries on PATH", () => {
    // python / node / bash are system binaries; we trust the shell to find them.
    expect(resolver.matches("python", ["-m", "mcp"])).toBeNull();
    expect(resolver.matches("node", ["server.js"])).toBeNull();
  });

  it("ignores ecosystem runner commands", () => {
    // Those are handled by the npm / pypi resolvers, not local-path.
    expect(resolver.matches("npx", [])).toBeNull();
    expect(resolver.matches("uvx", [])).toBeNull();
  });
});

describe("local-path resolver check", () => {
  let tmpDir: string;
  let existingFile: string;
  let existingDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "local-path-test-"));
    existingFile = join(tmpDir, "real-binary");
    existingDir = join(tmpDir, "a-dir");
    await writeFile(existingFile, "#!/bin/sh\n");
    // Directory: mkdtemp already makes one; create a second nested one.
    await mkdtemp(existingDir).catch(() => {});
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns ok when path exists and is a file", async () => {
    // Per-test resolver instance: avoid cache collisions across tests.
    const r = createLocalPathResolver();
    await expect(r.check(existingFile)).resolves.toEqual({ ok: true });
  });

  it("returns not_found for a missing path", async () => {
    const r = createLocalPathResolver();
    await expect(r.check(join(tmpDir, "nonexistent"))).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("caches results", async () => {
    const r = createLocalPathResolver();
    // Two calls against the same missing path — second is cached.
    const first = await r.check(join(tmpDir, "also-nonexistent"));
    const second = await r.check(join(tmpDir, "also-nonexistent"));
    expect(first).toEqual(second);
  });
});
