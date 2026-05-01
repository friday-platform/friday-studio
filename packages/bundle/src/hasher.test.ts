import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPrimitive } from "./hasher.ts";

describe("hashPrimitive", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bundle-hasher-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("produces a stable hash for identical content", async () => {
    await writeFile(join(dir, "a.txt"), "alpha\n");
    await writeFile(join(dir, "b.txt"), "beta\n");
    const a = await hashPrimitive(dir);
    const b = await hashPrimitive(dir);
    expect(a.hash).toBe(b.hash);
    expect(a.files).toEqual(["a.txt", "b.txt"]);
  });

  it("changes hash when a byte in a file changes", async () => {
    await writeFile(join(dir, "a.txt"), "alpha\n");
    const before = await hashPrimitive(dir);
    await writeFile(join(dir, "a.txt"), "alphx\n");
    const after = await hashPrimitive(dir);
    expect(after.hash).not.toBe(before.hash);
  });

  it("ignores file-creation order (lexical manifest)", async () => {
    await writeFile(join(dir, "b.txt"), "beta\n");
    await writeFile(join(dir, "a.txt"), "alpha\n");
    const result = await hashPrimitive(dir);
    expect(result.files).toEqual(["a.txt", "b.txt"]);
  });

  it("treats LF and CRLF text content as equivalent", async () => {
    await writeFile(join(dir, "text.md"), "line1\nline2\n");
    const lf = await hashPrimitive(dir);
    await writeFile(join(dir, "text.md"), "line1\r\nline2\r\n");
    const crlf = await hashPrimitive(dir);
    expect(crlf.hash).toBe(lf.hash);
  });

  it("preserves binary content byte-for-byte (no LF normalization)", async () => {
    const bin = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0xfe]);
    await writeFile(join(dir, "file.bin"), bin);
    const before = await hashPrimitive(dir);
    const swapped = Buffer.from([0x00, 0x0a, 0xff, 0xfe]);
    await writeFile(join(dir, "file.bin"), swapped);
    const after = await hashPrimitive(dir);
    expect(after.hash).not.toBe(before.hash);
  });

  it("excludes .DS_Store, .git/, and .tmp files", async () => {
    await writeFile(join(dir, "keep.txt"), "hi\n");
    await writeFile(join(dir, ".DS_Store"), "junk");
    await writeFile(join(dir, "scratch.tmp"), "junk");
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "HEAD"), "ref: main\n");
    const result = await hashPrimitive(dir);
    expect(result.files).toEqual(["keep.txt"]);
  });

  it("recurses into subdirectories with sorted relative paths", async () => {
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "b.txt"), "B\n");
    await writeFile(join(dir, "a.txt"), "A\n");
    const result = await hashPrimitive(dir);
    expect(result.files).toEqual(["a.txt", "nested/b.txt"]);
  });

  it("produces a readable manifest line per file", async () => {
    await writeFile(join(dir, "a.txt"), "alpha\n");
    const result = await hashPrimitive(dir);
    expect(result.manifest).toMatch(/^a\.txt sha256:[0-9a-f]{64}\n$/);
  });

  it("empty directory hashes to sha256 of empty manifest", async () => {
    const result = await hashPrimitive(dir);
    expect(result.files).toEqual([]);
    expect(result.manifest).toBe("");
    expect(result.hash).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
