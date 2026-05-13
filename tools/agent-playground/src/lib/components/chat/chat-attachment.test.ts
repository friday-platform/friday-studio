import { describe, expect, it } from "vitest";
import {
  buildArtifactAttachment,
  classifyAttachment,
  rejectionReason,
  rejectionToast,
} from "./chat-attachment.ts";

/**
 * Build a `File` for test fixtures. The browser-side `new File(...)` API
 * we use here is provided by happy-dom (configured for vitest in the
 * playground); we don't need to inject a polyfill.
 */
function makeFile(opts: { name: string; type?: string; contents?: string }): File {
  return new File([opts.contents ?? "x"], opts.name, { type: opts.type ?? "" });
}

describe("classifyAttachment", () => {
  it.each([
    { name: "screenshot.png", type: "image/png" },
    { name: "photo.jpg", type: "image/jpeg" },
    { name: "anim.gif", type: "image/gif" },
    { name: "art.webp", type: "image/webp" },
  ])(`returns "image" for $name`, ({ name, type }) => {
    expect(classifyAttachment(makeFile({ name, type }))).toBe("image");
  });

  it.each([
    // Browser-reported mime path
    { name: "notes.md", type: "text/markdown" },
    { name: "data.csv", type: "text/csv" },
    { name: "config.json", type: "application/json" },
    // Extension-fallback path (empty file.type — common on Linux/Windows)
    { name: "server.log", type: "" },
    { name: "Cargo.toml", type: "" },
    { name: "script.py", type: "" },
    { name: "page.html", type: "" },
    { name: "lib.ts", type: "" },
  ])(`returns "artifact" for $name (type="$type")`, ({ name, type }) => {
    expect(classifyAttachment(makeFile({ name, type }))).toBe("artifact");
  });

  it.each([
    // Browser-reported svg+xml MIME
    { name: "icon.svg", type: "image/svg+xml" },
    // File renamed to non-.svg but keeps the SVG mime
    { name: "icon.png", type: "image/svg+xml" },
    // Lowercase filename, no MIME (extension-only match)
    { name: "icon.svg", type: "" },
    // Case-insensitive extension match
    { name: "ICON.SVG", type: "" },
    { name: "Logo.Svg", type: "" },
  ])("refuses SVG ($name / $type) — script-injection guard", ({ name, type }) => {
    expect(classifyAttachment(makeFile({ name, type }))).toBeNull();
  });

  it.each([
    { name: "malware.exe", type: "application/octet-stream" },
    { name: "archive.zip", type: "application/zip" },
    { name: "no-extension", type: "" },
    { name: "video.mov", type: "video/quicktime" },
  ])("returns null for unsupported $name", ({ name, type }) => {
    expect(classifyAttachment(makeFile({ name, type }))).toBeNull();
  });

  it("falls back to file.type when extension is unknown but mime is text", () => {
    // .todo / .notes etc. aren't in EXTENSION_TO_MIME, but if the browser
    // tagged them as text/plain we still route through the artifact path
    // — the server's magic-byte sniff has the final say.
    expect(classifyAttachment(makeFile({ name: "scratch.todo", type: "text/plain" }))).toBe(
      "artifact",
    );
  });
});

describe("rejectionReason", () => {
  it("mentions script-injection for SVG", () => {
    const reason = rejectionReason(makeFile({ name: "evil.svg", type: "image/svg+xml" }));
    expect(reason).toMatch(/SVG/);
    expect(reason).toMatch(/script-injection/);
  });

  it("recognizes SVG by extension even with a deceptive MIME", () => {
    const reason = rejectionReason(makeFile({ name: "evil.svg", type: "image/png" }));
    expect(reason).toMatch(/SVG/);
  });

  it("echoes the filename for unknown extensions", () => {
    const reason = rejectionReason(makeFile({ name: "malware.exe" }));
    expect(reason).toContain(`"malware.exe"`);
  });

  it("enumerates accepted categories so the user knows what would work", () => {
    const reason = rejectionReason(makeFile({ name: "unknown.xyz" }));
    expect(reason).toMatch(/Text\/markup/);
    expect(reason).toMatch(/Source code/);
    expect(reason).toMatch(/Documents/);
    expect(reason).toMatch(/Images/);
    expect(reason).toMatch(/Audio/);
  });
});

describe("rejectionToast", () => {
  it("returns null when no files were refused", () => {
    expect(rejectionToast([])).toBeNull();
  });

  it("delegates to the single-file reason for one rejection (SVG keeps its specific copy)", () => {
    const out = rejectionToast([makeFile({ name: "icon.svg", type: "image/svg+xml" })]);
    expect(out?.title).toBe("Couldn't attach file");
    expect(out?.description).toMatch(/script-injection/);
  });

  it("coalesces multiple rejections into one summary toast (closes review #2)", () => {
    const out = rejectionToast([
      makeFile({ name: "a.exe" }),
      makeFile({ name: "b.zip" }),
      makeFile({ name: "c.svg", type: "image/svg+xml" }),
    ]);
    expect(out?.title).toBe("Couldn't attach 3 files");
    expect(out?.description).toContain(`"a.exe"`);
    expect(out?.description).toContain(`"b.zip"`);
    expect(out?.description).toContain(`"c.svg"`);
  });
});

describe("buildArtifactAttachment", () => {
  it("returns the initial state shape with status 'uploading' and progress 0", () => {
    const file = makeFile({ name: "data.csv", type: "text/csv" });
    const att = buildArtifactAttachment(file);
    expect(att.kind).toBe("artifact");
    expect(att.file).toBe(file);
    expect(att.mediaType).toBe("text/csv");
    expect(att.status).toBe("uploading");
    expect(att.progress).toBe(0);
    expect(att.artifactId).toBeUndefined();
    expect(att.errorMessage).toBeUndefined();
    expect(att.abortController).toBeInstanceOf(AbortController);
    expect(att.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("falls back to inferred mime when the browser didn't report one", () => {
    // .md → text/markdown via inferMimeFromFilename. Without this fallback
    // the chip would show "application/octet-stream" instead of the
    // real text/markdown mime.
    const att = buildArtifactAttachment(makeFile({ name: "notes.md", type: "" }));
    expect(att.mediaType).toBe("text/markdown");
  });

  it("falls back to application/octet-stream when no mime can be inferred", () => {
    const att = buildArtifactAttachment(makeFile({ name: "scratch.todo", type: "" }));
    expect(att.mediaType).toBe("application/octet-stream");
  });
});
