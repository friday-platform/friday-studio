import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteEnvFileVar, loadEnvFile, loadWorkspaceEnv, setEnvFileVar } from "./workspace-env.ts";

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

describe("setEnvFileVar / deleteEnvFileVar", () => {
  let dir: string;
  let envPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "workspace-env-edit-"));
    envPath = join(dir, ".env");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the file lazily on first set", () => {
    expect(existsSync(envPath)).toBe(false);
    setEnvFileVar(envPath, "FOO", "bar");
    expect(existsSync(envPath)).toBe(true);
    expect(loadEnvFile(envPath)).toEqual({ FOO: "bar" });
  });

  it("replaces an existing key in place, leaving comments and other keys untouched", async () => {
    await writeFile(envPath, "# header comment\nFOO=old\nBAR=keep\n# trailing note\n");
    setEnvFileVar(envPath, "FOO", "new");
    expect(readFileSync(envPath, "utf-8")).toBe(
      "# header comment\nFOO=new\nBAR=keep\n# trailing note\n",
    );
  });

  it("appends a new key without disturbing existing content", async () => {
    await writeFile(envPath, "# comment\nFOO=bar\n");
    setEnvFileVar(envPath, "BAZ", "qux");
    expect(readFileSync(envPath, "utf-8")).toBe("# comment\nFOO=bar\nBAZ=qux\n");
  });

  it("quotes values that need it so they round-trip through the parser", () => {
    setEnvFileVar(envPath, "WITH_SPACE", "a b c");
    setEnvFileVar(envPath, "WITH_HASH", "a#b");
    setEnvFileVar(envPath, "WITH_QUOTE", "it's");
    expect(loadEnvFile(envPath)).toEqual({
      WITH_SPACE: "a b c",
      WITH_HASH: "a#b",
      WITH_QUOTE: "it's",
    });
  });

  it("collapses duplicate assignments for the same key", async () => {
    await writeFile(envPath, "FOO=one\nBAR=x\nFOO=two\n");
    setEnvFileVar(envPath, "FOO", "three");
    expect(readFileSync(envPath, "utf-8")).toBe("FOO=three\nBAR=x\n");
  });

  it("deletes a key, preserving comments and other keys", async () => {
    await writeFile(envPath, "# comment\nFOO=bar\nBAR=keep\n");
    expect(deleteEnvFileVar(envPath, "FOO")).toBe(true);
    expect(readFileSync(envPath, "utf-8")).toBe("# comment\nBAR=keep\n");
  });

  it("returns false when deleting an absent key or file", async () => {
    expect(deleteEnvFileVar(envPath, "MISSING")).toBe(false);
    await writeFile(envPath, "FOO=bar\n");
    expect(deleteEnvFileVar(envPath, "MISSING")).toBe(false);
  });

  it("handles export-prefixed assignments", async () => {
    await writeFile(envPath, "export FOO=bar\n");
    setEnvFileVar(envPath, "FOO", "new");
    expect(loadEnvFile(envPath)).toEqual({ FOO: "new" });
    expect(deleteEnvFileVar(envPath, "FOO")).toBe(true);
    expect(loadEnvFile(envPath)).toEqual({});
  });
});
