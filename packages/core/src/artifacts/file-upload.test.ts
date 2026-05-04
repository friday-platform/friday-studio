import { describe, expect, it } from "vitest";
import {
  ALLOWED_EXTENSIONS,
  deriveDownloadFilename,
  getValidatedMimeType,
  inferMimeFromFilename,
} from "./file-upload.ts";

describe("deriveDownloadFilename", () => {
  it("preserves originalName extension when stored mime is octet-stream and original ext is non-bin", () => {
    // Bug case: agent created an artifact whose mime got defaulted to
    // octet-stream (e.g. text format with no magic bytes). The original
    // filename has the correct extension — trust it instead of rewriting
    // to .bin.
    const result = deriveDownloadFilename({
      mimeType: "application/octet-stream",
      originalName: "report.html",
      title: "A report",
    });
    expect(result).toBe("report.html");
  });

  it("rewrites a .bin originalName when a real mime is known (scrubber path)", () => {
    // Scrubber stamps `<tool>-<ts>.bin` before mime is sniffed; once we
    // know the real mime, the extension should be corrected.
    const result = deriveDownloadFilename({
      mimeType: "image/png",
      originalName: "gmail_get_attachment-1234.bin",
      title: "Attachment",
    });
    expect(result).toBe("gmail_get_attachment-1234.png");
  });

  it("preserves originalName when mime does not round-trip through extFromMime", () => {
    // text/x-typescript fails extFromMime's `[a-z0-9]+` regex (hyphen),
    // so the old logic rewrote `script.ts` → `script.bin`. Filenames
    // should follow originalName when its extension is meaningful.
    const result = deriveDownloadFilename({
      mimeType: "text/x-typescript",
      originalName: "script.ts",
      title: "Script",
    });
    expect(result).toBe("script.ts");
  });

  // Round-trip lock: every mime the agent-side inference can stamp on
  // an artifact must result in a download filename that preserves the
  // original extension. This blocks the regression Ken's reviewer
  // surfaced — ~12 of 22 inferred mimes failed to round-trip through
  // extFromMime under the old logic.
  it.each([
    ["text/html", "page.html"],
    ["text/html", "page.htm"],
    ["application/xml", "feed.xml"],
    ["image/svg+xml", "icon.svg"],
    ["text/css", "site.css"],
    ["text/x-typescript", "script.ts"],
    ["text/x-typescript", "Component.tsx"],
    ["text/javascript", "app.js"],
    ["text/javascript", "Component.jsx"],
    ["text/javascript", "loader.mjs"],
    ["text/javascript", "loader.cjs"],
    ["text/x-python", "main.py"],
    ["text/x-go", "main.go"],
    ["text/x-rust", "lib.rs"],
    ["text/x-shellscript", "deploy.sh"],
    ["text/x-shellscript", "setup.bash"],
    ["text/x-sql", "migration.sql"],
    ["text/x-toml", "Cargo.toml"],
    ["text/plain", "config.ini"],
    ["text/plain", "nginx.conf"],
    ["text/plain", "build.log"],
    ["text/tab-separated-values", "data.tsv"],
    ["text/markdown", "SKILL.md"],
    ["text/csv", "rows.csv"],
    ["application/json", "package.json"],
  ])("round-trips %s as %s", (mimeType, originalName) => {
    expect(deriveDownloadFilename({ mimeType, originalName, title: "irrelevant" })).toBe(
      originalName,
    );
  });

  it("appends mime extension when originalName has no extension", () => {
    const result = deriveDownloadFilename({
      mimeType: "application/pdf",
      originalName: "report",
      title: "Report",
    });
    expect(result).toBe("report.pdf");
  });

  it("falls back to title.<ext> when originalName is missing", () => {
    const result = deriveDownloadFilename({ mimeType: "text/markdown", title: "release-notes" });
    expect(result).toBe("release-notes.md");
  });
});

describe("inferMimeFromFilename", () => {
  it("returns the mime for an upload-allowlisted extension", () => {
    expect(inferMimeFromFilename("notes.md")).toBe("text/markdown");
  });

  it("returns the mime for a non-uploadable but inferable extension", () => {
    expect(inferMimeFromFilename("script.ts")).toBe("text/x-typescript");
  });

  it("returns undefined for an unknown extension", () => {
    expect(inferMimeFromFilename("artifact.unknownext")).toBeUndefined();
  });

  it("returns undefined when the filename has no extension", () => {
    expect(inferMimeFromFilename("README")).toBeUndefined();
  });
});

describe("getValidatedMimeType", () => {
  it("returns the mime for an uploadable extension", () => {
    expect(getValidatedMimeType("notes.md")).toBe("text/markdown");
  });

  it("returns undefined for a non-uploadable extension (gates UI uploads)", () => {
    // .ts is inferable for agent-side artifact creation but must NOT be
    // accepted via the UI upload allowlist.
    expect(getValidatedMimeType("script.ts")).toBeUndefined();
  });
});

describe("ALLOWED_EXTENSIONS", () => {
  it("contains user-uploadable extensions", () => {
    expect(ALLOWED_EXTENSIONS.has(".md")).toBe(true);
    expect(ALLOWED_EXTENSIONS.has(".pdf")).toBe(true);
  });

  it("does not contain agent-only inferred extensions", () => {
    expect(ALLOWED_EXTENSIONS.has(".ts")).toBe(false);
    expect(ALLOWED_EXTENSIONS.has(".html")).toBe(false);
    expect(ALLOWED_EXTENSIONS.has(".sh")).toBe(false);
  });
});
