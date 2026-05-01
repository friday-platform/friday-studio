/**
 * PDF to Markdown Converter Tests
 *
 * Tests PDF text extraction and markdown formatting using real PDF fixtures
 * generated with @libpdf/core. Minimal mocking - only for encrypted PDF errors
 * since @libpdf/core cannot create encrypted PDFs programmatically.
 */

import { black, PDF } from "@libpdf/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pdfToMarkdown } from "./pdf-to-markdown.ts";

/**
 * Generate a valid single-page PDF with specified text content.
 */
async function createPdfWithText(text: string): Promise<Uint8Array> {
  const pdf = PDF.create();
  pdf.addPage({ size: "letter" });
  const page = pdf.getPage(0);
  if (!page) throw new Error("Failed to get page");

  page.drawText(text, { x: 50, y: 350, size: 12, color: black });

  return await pdf.save();
}

/**
 * Generate a multi-page PDF with text on each page
 */
async function createMultiPagePdf(pages: string[]): Promise<Uint8Array> {
  const pdf = PDF.create();

  for (let i = 0; i < pages.length; i++) {
    pdf.addPage({ size: "letter" });
    const page = pdf.getPage(i);
    if (!page) throw new Error(`Failed to get page ${i}`);

    page.drawText(pages[i] ?? "", { x: 50, y: 350, size: 12, color: black });
  }

  return await pdf.save();
}

/**
 * Generate corrupted PDF bytes that @libpdf/core cannot parse
 */
function createCorruptPdf(): Uint8Array {
  // PDF header followed by garbage - will fail to parse
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...Array(50).fill(0xff)]);
}

/**
 * Generate a PDF with no text (simulates scanned/image-only PDF)
 */
async function createEmptyPdf(): Promise<Uint8Array> {
  const pdf = PDF.create();
  pdf.addPage({ size: "letter" });
  return await pdf.save();
}

/**
 * Generate content >= 15 chars for tests that need to pass empty check.
 * The converter strips whitespace and page headers before checking length.
 */
function generateLongContent(base: string): string {
  return base.padEnd(20, ".");
}

describe("pdfToMarkdown", () => {
  describe("valid PDFs", () => {
    it("converts single-page PDF to markdown with title and page header", async () => {
      const content = generateLongContent("This is a test document with sufficient content");
      const pdfBytes = await createPdfWithText(content);

      const result = await pdfToMarkdown(pdfBytes, "report.pdf");

      expect(result).toContain("# report.pdf");
      expect(result).toContain("## Page 1");
      expect(result).toContain(content);
    });

    it("converts multi-page PDF with correct ## Page N headers for each page", async () => {
      const pages = [
        generateLongContent("First page with content"),
        generateLongContent("Second page also here"),
        generateLongContent("Third page finishes it"),
      ];
      const pdfBytes = await createMultiPagePdf(pages);

      const result = await pdfToMarkdown(pdfBytes, "multi.pdf");

      expect(result).toContain("# multi.pdf");
      expect(result).toContain("## Page 1");
      expect(result).toContain("## Page 2");
      expect(result).toContain("## Page 3");
      expect(result).toContain("First page with content");
      expect(result).toContain("Second page also here");
      expect(result).toContain("Third page finishes it");
    });
  });

  describe("error cases", () => {
    it("throws with 'corrupted' in message for corrupt PDFs", async () => {
      const corruptBytes = createCorruptPdf();

      await expect(pdfToMarkdown(corruptBytes, "broken.pdf")).rejects.toThrow(/corrupted/i);
    });
  });

  describe("edge cases", () => {
    it("returns notice message for empty extraction (no readable text)", async () => {
      const emptyPdfBytes = await createEmptyPdf();

      const result = await pdfToMarkdown(emptyPdfBytes, "scan.pdf");

      expect(result).toContain("# scan.pdf");
      expect(result).toContain("Notice:");
      expect(result).toContain("images or scanned content");
    });

    it("returns notice when content is below empty threshold", async () => {
      const shortContent = "Tiny.";
      const pdfBytes = await createPdfWithText(shortContent);

      const result = await pdfToMarkdown(pdfBytes, "short.pdf");

      expect(result).toContain("# short.pdf");
      expect(result).toContain("Notice:");
    });
  });
});

/**
 * Test encrypted PDF handling via mock.
 * @libpdf/core cannot create encrypted PDFs programmatically, so we mock for this test.
 */
describe("pdfToMarkdown - encrypted PDF error handling", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("throws with 'password-protected' message for AuthenticationError", async () => {
    const authError = new Error("Authentication failed");
    authError.name = "AuthenticationError";

    vi.doMock("@libpdf/core", () => ({ PDF: { load: vi.fn().mockRejectedValue(authError) } }));

    const { pdfToMarkdown: pdfToMarkdownMocked } = await import("./pdf-to-markdown.ts");
    const buffer = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

    await expect(pdfToMarkdownMocked(buffer, "secret.pdf")).rejects.toThrow(/password-protected/);
  });

  it("throws with 'password-protected' for encrypted but unauthenticated PDF", async () => {
    vi.doMock("@libpdf/core", () => ({
      PDF: {
        load: vi
          .fn()
          .mockResolvedValue({ isEncrypted: true, isAuthenticated: false, extractText: vi.fn() }),
      },
    }));

    const { pdfToMarkdown: pdfToMarkdownMocked } = await import("./pdf-to-markdown.ts");
    const buffer = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

    await expect(pdfToMarkdownMocked(buffer, "secret.pdf")).rejects.toThrow(/password-protected/);
  });

  it("re-throws unknown errors unchanged", async () => {
    vi.doMock("@libpdf/core", () => ({
      PDF: { load: vi.fn().mockRejectedValue(new Error("Unexpected internal error")) },
    }));

    const { pdfToMarkdown: pdfToMarkdownMocked } = await import("./pdf-to-markdown.ts");
    const buffer = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

    await expect(pdfToMarkdownMocked(buffer, "weird.pdf")).rejects.toThrow(
      "Unexpected internal error",
    );
  });
});
