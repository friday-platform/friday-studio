import { describe, expect, it } from "vitest";
import {
  ALLOWED_EXTENSIONS,
  deriveDownloadFilename,
  getValidatedMimeType,
  inferMimeFromFilename,
  stripMimeParams,
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

  it("rewrites originalName when stored mime proves the extension is wrong", () => {
    const result = deriveDownloadFilename({
      mimeType: "image/png",
      originalName: "misnamed.txt",
      title: "Misnamed image",
    });
    expect(result).toBe("misnamed.png");
  });

  it("preserves originalName when stored mime carries a charset parameter", () => {
    // Storage adapters that normalize text mimes with charset round-trip
    // them as `text/markdown; charset=utf-8`. The extension comparison
    // must ignore the parameter — otherwise `notes.md` silently rewrites
    // to `notes.markdown` because `extFromMime` strips the parameter
    // while the equality check did not.
    const result = deriveDownloadFilename({
      mimeType: "text/markdown; charset=utf-8",
      originalName: "notes.md",
      title: "Notes",
    });
    expect(result).toBe("notes.md");
  });

  // Scrubber path with the hyphenated source-code mimes this PR
  // introduces. Without reverse-map entries, `extFromMime` falls back
  // to the alnum-only regex, rejects the hyphenated tail, and returns
  // `bin` — leaving the placeholder unrepaired.
  it.each([
    ["text/x-typescript", "ts"],
    ["text/x-python", "py"],
    ["text/x-go", "go"],
    ["text/x-rust", "rs"],
    ["text/x-shellscript", "sh"],
    ["text/x-sql", "sql"],
    ["text/x-toml", "toml"],
    ["text/tab-separated-values", "tsv"],
  ])("repairs scrubber-stamped .bin for mime %s → .%s", (mime, ext) => {
    const result = deriveDownloadFilename({
      mimeType: mime,
      originalName: "scrubber_tool-12345.bin",
      title: "irrelevant",
    });
    expect(result).toBe(`scrubber_tool-12345.${ext}`);
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

describe("stripMimeParams", () => {
  it("returns the canonical type/subtype when a parameter is present", () => {
    expect(stripMimeParams("text/html; charset=utf-8")).toBe("text/html");
  });

  it("trims whitespace before the parameter separator", () => {
    expect(stripMimeParams("text/markdown ; charset=utf-8")).toBe("text/markdown");
  });

  it("returns the input unchanged when no parameter is present", () => {
    expect(stripMimeParams("application/pdf")).toBe("application/pdf");
  });

  it("falls back to the original on a malformed empty-prefix mime", () => {
    // `;…` has no type/subtype before the separator. Returning the raw
    // input is the right tradeoff vs. silently producing an empty string
    // that could match unrelated equality checks downstream.
    expect(stripMimeParams("; charset=utf-8")).toBe("; charset=utf-8");
  });
});
