import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { docxToMarkdown } from "./docx-to-markdown.ts";
import { ConverterError } from "./xml-utils.ts";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/**
 * Build a minimal DOCX ZIP from raw document.xml content.
 * Includes [Content_Types].xml for proper OOXML MIME detection.
 */
async function buildDocx(documentXml: string): Promise<Uint8Array> {
  const zip = new JSZip();

  // [Content_Types].xml required for file-type OOXML detection
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );

  zip.file("word/document.xml", documentXml);

  return await zip.generateAsync({ type: "uint8array" });
}

/**
 * Wrap body XML in a full document.xml with proper namespaces.
 */
function wrapDocument(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${bodyXml}</w:body>
</w:document>`;
}

describe("docxToMarkdown", () => {
  describe("valid DOCX files", () => {
    it("converts simple paragraphs to markdown", async () => {
      const xml = wrapDocument(`
        <w:p><w:r><w:t>Hello, world!</w:t></w:r></w:p>
        <w:p><w:r><w:t>Second paragraph here with enough text.</w:t></w:r></w:p>
      `);
      const buffer = await buildDocx(xml);

      const result = await docxToMarkdown(buffer, "test.docx");

      expect(result).toContain("# test.docx");
      expect(result).toContain("Hello, world!");
      expect(result).toContain("Second paragraph here with enough text.");
    });

    it("converts headings to markdown heading syntax", async () => {
      const xml = wrapDocument(`
        <w:p>
          <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
          <w:r><w:t>Main Title</w:t></w:r>
        </w:p>
        <w:p>
          <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
          <w:r><w:t>Subtitle</w:t></w:r>
        </w:p>
        <w:p><w:r><w:t>Body text with sufficient content for the test.</w:t></w:r></w:p>
      `);
      const buffer = await buildDocx(xml);

      const result = await docxToMarkdown(buffer, "headings.docx");

      expect(result).toMatch(/^# Main Title$/m);
      expect(result).toMatch(/^## Subtitle$/m);
      expect(result).toContain("Body text with sufficient content for the test.");
    });

    it("applies bold and italic formatting", async () => {
      const xml = wrapDocument(`
        <w:p>
          <w:r><w:rPr><w:b/></w:rPr><w:t>Bold text</w:t></w:r>
          <w:r><w:t> normal </w:t></w:r>
          <w:r><w:rPr><w:i/></w:rPr><w:t>italic text</w:t></w:r>
        </w:p>
        <w:p>
          <w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>Bold and italic together</w:t></w:r>
        </w:p>
      `);
      const buffer = await buildDocx(xml);

      const result = await docxToMarkdown(buffer, "formatting.docx");

      expect(result).toContain("**Bold text**");
      expect(result).toContain("*italic text*");
      expect(result).toContain("***Bold and italic together***");
    });

    it("converts list items with bullet markers", async () => {
      const xml = wrapDocument(`
        <w:p>
          <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
          <w:r><w:t>First item in the list with enough content.</w:t></w:r>
        </w:p>
        <w:p>
          <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
          <w:r><w:t>Second item in the list with some text.</w:t></w:r>
        </w:p>
      `);
      const buffer = await buildDocx(xml);

      const result = await docxToMarkdown(buffer, "list.docx");

      expect(result).toContain("- First item in the list with enough content.");
      expect(result).toContain("- Second item in the list with some text.");
    });

    it("converts tables to markdown table syntax", async () => {
      const xml = wrapDocument(`
        <w:tbl>
          <w:tr>
            <w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>Age</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:tc><w:p><w:r><w:t>Alice</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>30</w:t></w:r></w:p></w:tc>
          </w:tr>
        </w:tbl>
        <w:p><w:r><w:t>Some text after the table for content check.</w:t></w:r></w:p>
      `);
      const buffer = await buildDocx(xml);

      const result = await docxToMarkdown(buffer, "table.docx");

      expect(result).toContain("| Name | Age |");
      expect(result).toContain("| --- | --- |");
      expect(result).toContain("| Alice | 30 |");
    });
  });

  describe("error cases", () => {
    it("throws CORRUPTED ConverterError for corrupted ZIP data", async () => {
      const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      try {
        await docxToMarkdown(garbage, "bad.docx");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConverterError);
        expect(err).toHaveProperty("code", "CORRUPTED");
        expect(err).toHaveProperty("message", expect.stringMatching(/corrupted or invalid/));
      }
    });

    it("throws PASSWORD_PROTECTED ConverterError for encrypted DOCX", async () => {
      const zip = new JSZip();
      zip.file("EncryptedPackage", "encrypted data");
      zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
      );
      const buffer = await zip.generateAsync({ type: "uint8array" });

      try {
        await docxToMarkdown(buffer, "secret.docx");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConverterError);
        expect(err).toHaveProperty("code", "PASSWORD_PROTECTED");
        expect(err).toHaveProperty("message", expect.stringMatching(/password-protected/));
      }
    });

    it("throws CORRUPTED when word/document.xml is missing", async () => {
      const zip = new JSZip();
      zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
      );
      zip.file("word/styles.xml", "<styles/>");
      const buffer = await zip.generateAsync({ type: "uint8array" });

      await expect(docxToMarkdown(buffer, "missing.docx")).rejects.toThrow(/corrupted or invalid/);
    });

    it("throws DECOMPRESSION_LIMIT for oversized decompressed content", async () => {
      // Create a ZIP where a single entry exceeds the limit when decompressed.
      // Use compressible data (repeated zeros) so the compressed ZIP stays small.
      const zip = new JSZip();
      zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
      );
      // 201MB of zeros — compresses extremely well
      const largeData = new Uint8Array(201 * 1024 * 1024);
      zip.file("word/media/image1.bin", largeData);
      zip.file("word/document.xml", wrapDocument(`<w:p><w:r><w:t>text</w:t></w:r></w:p>`));
      const buffer = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });

      try {
        await docxToMarkdown(buffer, "bomb.docx");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConverterError);
        expect(err).toHaveProperty("code", "DECOMPRESSION_LIMIT");
      }
    }, 30_000);
  });

  describe("edge cases", () => {
    it("returns notice for empty document body", async () => {
      const xml = wrapDocument("");
      const buffer = await buildDocx(xml);

      const result = await docxToMarkdown(buffer, "empty.docx");

      expect(result).toContain("# empty.docx");
      expect(result).toContain("Notice:");
    });

    it("returns notice for document with only whitespace content", async () => {
      const xml = wrapDocument(`<w:p><w:r><w:t>   </w:t></w:r></w:p>`);
      const buffer = await buildDocx(xml);

      const result = await docxToMarkdown(buffer, "whitespace.docx");

      expect(result).toContain("Notice:");
    });

    it("handles document without w:body element", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}"/>`;
      const buffer = await buildDocx(xml);

      const result = await docxToMarkdown(buffer, "nobody.docx");

      expect(result).toContain("# nobody.docx");
      expect(result).toContain("Notice:");
    });

    it("extracts text from hyperlinks", async () => {
      const xml = wrapDocument(`
        <w:p>
          <w:r><w:t>Click </w:t></w:r>
          <w:hyperlink r:id="rId1">
            <w:r><w:t>this link</w:t></w:r>
          </w:hyperlink>
          <w:r><w:t> for more info about this topic.</w:t></w:r>
        </w:p>
      `);
      const buffer = await buildDocx(xml);

      const result = await docxToMarkdown(buffer, "links.docx");

      expect(result).toContain("Click this link for more info about this topic.");
    });

    it("handles tab and line break elements", async () => {
      const xml = wrapDocument(`
        <w:p>
          <w:r>
            <w:t>Before</w:t>
            <w:tab/>
            <w:t>After tab and some more text here.</w:t>
          </w:r>
        </w:p>
        <w:p>
          <w:r>
            <w:t>Line one</w:t>
            <w:br/>
            <w:t>Line two after break with extra text.</w:t>
          </w:r>
        </w:p>
      `);
      const buffer = await buildDocx(xml);

      const result = await docxToMarkdown(buffer, "tabs.docx");

      expect(result).toContain("Before\tAfter tab");
      expect(result).toContain("Line one\nLine two after break");
    });

    it("pads table rows with fewer cells than header", async () => {
      const xml = wrapDocument(`
        <w:tbl>
          <w:tr>
            <w:tc><w:p><w:r><w:t>Col1</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>Col2</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>Col3</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:tc><w:p><w:r><w:t>Val1</w:t></w:r></w:p></w:tc>
          </w:tr>
        </w:tbl>
        <w:p><w:r><w:t>Text after table for content threshold.</w:t></w:r></w:p>
      `);
      const buffer = await buildDocx(xml);

      const result = await docxToMarkdown(buffer, "padded.docx");

      expect(result).toContain("| Col1 | Col2 | Col3 |");
      expect(result).toContain("| Val1 |  |  |");
    });

    it("handles multiple runs in a single paragraph", async () => {
      const xml = wrapDocument(`
        <w:p>
          <w:r><w:t>Part one </w:t></w:r>
          <w:r><w:t>part two </w:t></w:r>
          <w:r><w:t>part three enough text for threshold.</w:t></w:r>
        </w:p>
      `);
      const buffer = await buildDocx(xml);

      const result = await docxToMarkdown(buffer, "multirun.docx");

      expect(result).toContain("Part one part two part three enough text for threshold.");
    });
  });
});
