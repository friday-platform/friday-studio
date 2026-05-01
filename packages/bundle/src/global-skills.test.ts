import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportGlobalSkills, importGlobalSkills } from "./global-skills.ts";

// Use a synthetic byte string to stand in for a real SQLite file — the bundle
// code treats skills.db as opaque bytes, so we only need round-trip + hash
// integrity coverage, not a real DB.
async function seedDb(path: string, contents: string) {
  await writeFile(path, contents);
}

describe("exportGlobalSkills + importGlobalSkills", () => {
  let srcDir: string;
  let dstDir: string;

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), "global-skills-src-"));
    dstDir = await mkdtemp(join(tmpdir(), "global-skills-dst-"));
  });
  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
  });

  it("returns { bytes: null } when source skills.db is missing", async () => {
    const result = await exportGlobalSkills({ skillsDbPath: join(srcDir, "missing.db") });
    expect(result.bytes).toBeNull();
  });

  it("round-trips bytes into a fresh target", async () => {
    const srcDb = join(srcDir, "skills.db");
    await seedDb(srcDb, "pretend-sqlite-bytes");
    const exported = await exportGlobalSkills({ skillsDbPath: srcDb });
    expect(exported.bytes).toBeTruthy();
    expect(exported.manifest?.source.byteSize).toBe("pretend-sqlite-bytes".length);

    const dstDb = join(dstDir, "skills.db");
    const result = await importGlobalSkills({ zipBytes: exported.bytes!, skillsDbPath: dstDb });
    expect(result.status.kind).toBe("imported");
    if (result.status.kind !== "imported") throw new Error("unreachable");
    expect(result.status.bytesWritten).toBe("pretend-sqlite-bytes".length);

    const read = await readFile(dstDb, "utf-8");
    expect(read).toBe("pretend-sqlite-bytes");
  });

  it("sideloads and preserves existing target when skills.db already present", async () => {
    const srcDb = join(srcDir, "skills.db");
    await seedDb(srcDb, "source-skills");
    const exported = await exportGlobalSkills({ skillsDbPath: srcDb });
    expect(exported.bytes).toBeTruthy();

    const dstDb = join(dstDir, "skills.db");
    await seedDb(dstDb, "pre-existing");
    const result = await importGlobalSkills({ zipBytes: exported.bytes!, skillsDbPath: dstDb });

    expect(result.status.kind).toBe("skipped-existing");
    if (result.status.kind !== "skipped-existing") throw new Error("unreachable");
    expect(await readFile(dstDb, "utf-8")).toBe("pre-existing");
    expect(await readFile(result.status.sideloadedAs, "utf-8")).toBe("source-skills");
  });

  it("rejects on integrity mismatch", async () => {
    const srcDb = join(srcDir, "skills.db");
    await seedDb(srcDb, "some-db");
    const exported = await exportGlobalSkills({ skillsDbPath: srcDb });
    expect(exported.bytes).toBeTruthy();

    // Tamper with the zipped skills.db: load, replace, re-zip.
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(exported.bytes!);
    zip.file("skills.db", "tampered");
    const tampered = await zip.generateAsync({ type: "uint8array" });

    const result = await importGlobalSkills({
      zipBytes: tampered,
      skillsDbPath: join(dstDir, "skills.db"),
    });
    expect(result.status.kind).toBe("integrity-failed");
  });
});
