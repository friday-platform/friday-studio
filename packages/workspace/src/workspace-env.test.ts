import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspaceEnv } from "./workspace-env.ts";

describe("loadWorkspaceEnv", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "workspace-env-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses a workspace .env into a record", async () => {
    await writeFile(join(dir, ".env"), "FOO=bar\nBAZ=qux\n");
    expect(loadWorkspaceEnv(dir)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("returns an empty overlay when the .env file is absent", () => {
    // Lazy-on-write: no workspace pre-creates a .env, and absence is valid.
    expect(loadWorkspaceEnv(dir)).toEqual({});
  });

  it("returns an empty overlay for a non-existent workspace path", () => {
    expect(loadWorkspaceEnv(join(dir, "does-not-exist"))).toEqual({});
  });
});
