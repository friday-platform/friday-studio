import { describe, expect, it } from "vitest";
import { deriveDownloadFilename } from "./file-upload.ts";

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
});
