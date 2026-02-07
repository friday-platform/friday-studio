import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { pptxToMarkdown } from "./pptx-to-markdown.ts";
import { ConverterError } from "./xml-utils.ts";

const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * Build a minimal PPTX ZIP with slides.
 * Includes [Content_Types].xml, presentation.xml, and relationships for proper OOXML detection.
 */
async function buildPptx(slides: { text: string }[]): Promise<Uint8Array> {
  const zip = new JSZip();

  // [Content_Types].xml required for file-type OOXML detection
  const overrides = slides
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join("\n  ");

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${overrides}
</Types>`,
  );

  // Build presentation.xml with slide references
  const sldIdEntries = slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
    .join("\n    ");

  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="${P_NS}"
                xmlns:r="${R_NS}"
                xmlns:a="${A_NS}">
  <p:sldIdLst>
    ${sldIdEntries}
  </p:sldIdLst>
</p:presentation>`,
  );

  // Build presentation.xml.rels
  const relEntries = slides
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
    )
    .join("\n  ");

  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relEntries}
</Relationships>`,
  );

  // Build slide XML files
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    if (!slide) continue;

    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:p>
            <a:r><a:t>${escapeXml(slide.text)}</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`,
    );
  }

  return await zip.generateAsync({ type: "uint8array" });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

describe("pptxToMarkdown", () => {
  describe("valid PPTX files", () => {
    it("converts single slide to markdown with slide header", async () => {
      const buffer = await buildPptx([{ text: "Welcome to the presentation" }]);

      const result = await pptxToMarkdown(buffer, "deck.pptx");

      expect(result).toContain("# deck.pptx");
      expect(result).toContain("## Slide 1");
      expect(result).toContain("Welcome to the presentation");
    });

    it("converts multiple slides with correct numbering", async () => {
      const buffer = await buildPptx([
        { text: "Introduction" },
        { text: "Main Content" },
        { text: "Conclusion" },
      ]);

      const result = await pptxToMarkdown(buffer, "multi.pptx");

      expect(result).toContain("# multi.pptx");
      expect(result).toContain("## Slide 1");
      expect(result).toContain("Introduction");
      expect(result).toContain("## Slide 2");
      expect(result).toContain("Main Content");
      expect(result).toContain("## Slide 3");
      expect(result).toContain("Conclusion");
    });

    it("preserves slide order from presentation.xml", async () => {
      const buffer = await buildPptx([{ text: "First" }, { text: "Second" }, { text: "Third" }]);

      const result = await pptxToMarkdown(buffer, "order.pptx");

      // Slides should appear in order
      const firstIdx = result.indexOf("First");
      const secondIdx = result.indexOf("Second");
      const thirdIdx = result.indexOf("Third");
      expect(firstIdx).toBeLessThan(secondIdx);
      expect(secondIdx).toBeLessThan(thirdIdx);
    });
  });

  describe("error cases", () => {
    it("throws CORRUPTED ConverterError for corrupted ZIP data", async () => {
      const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      try {
        await pptxToMarkdown(garbage, "bad.pptx");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConverterError);
        expect(err).toHaveProperty("code", "CORRUPTED");
        expect(err).toHaveProperty("message", expect.stringMatching(/corrupted or invalid/));
      }
    });

    it("throws PASSWORD_PROTECTED ConverterError for encrypted PPTX", async () => {
      const zip = new JSZip();
      zip.file("EncryptedPackage", "encrypted data");
      zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
      );
      const buffer = await zip.generateAsync({ type: "uint8array" });

      try {
        await pptxToMarkdown(buffer, "secret.pptx");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConverterError);
        expect(err).toHaveProperty("code", "PASSWORD_PROTECTED");
        expect(err).toHaveProperty("message", expect.stringMatching(/password-protected/));
      }
    });

    it("throws DECOMPRESSION_LIMIT for oversized decompressed content", async () => {
      const zip = new JSZip();
      zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
      );
      // 201MB of zeros — compresses extremely well
      const largeData = new Uint8Array(201 * 1024 * 1024);
      zip.file("ppt/media/image1.bin", largeData);
      zip.file(
        "ppt/slides/slide1.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
      );
      const buffer = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });

      try {
        await pptxToMarkdown(buffer, "bomb.pptx");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConverterError);
        expect(err).toHaveProperty("code", "DECOMPRESSION_LIMIT");
      }
    }, 30_000);
  });

  describe("edge cases", () => {
    it("returns notice for PPTX with no slides", async () => {
      const zip = new JSZip();
      zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
      );
      zip.file(
        "ppt/presentation.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}" xmlns:a="${A_NS}">
  <p:sldIdLst/>
</p:presentation>`,
      );
      zip.file(
        "ppt/_rels/presentation.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
      );
      const buffer = await zip.generateAsync({ type: "uint8array" });

      const result = await pptxToMarkdown(buffer, "empty.pptx");

      expect(result).toContain("# empty.pptx");
      expect(result).toContain("Notice:");
      expect(result).toContain("no slides");
    });

    it("marks empty slides as (empty slide)", async () => {
      const zip = new JSZip();
      zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
      );
      zip.file(
        "ppt/presentation.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}" xmlns:a="${A_NS}">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>`,
      );
      zip.file(
        "ppt/_rels/presentation.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
      );
      // Empty slide - no text shapes
      zip.file(
        "ppt/slides/slide1.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}">
  <p:cSld><p:spTree/></p:cSld>
</p:sld>`,
      );
      const buffer = await zip.generateAsync({ type: "uint8array" });

      const result = await pptxToMarkdown(buffer, "blank.pptx");

      expect(result).toContain("## Slide 1");
      expect(result).toContain("(empty slide)");
    });

    it("handles multiple text shapes per slide", async () => {
      const zip = new JSZip();
      zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
      );
      zip.file(
        "ppt/presentation.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}" xmlns:a="${A_NS}">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>`,
      );
      zip.file(
        "ppt/_rels/presentation.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
      );
      zip.file(
        "ppt/slides/slide1.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:p><a:r><a:t>Title Shape</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:txBody>
          <a:p><a:r><a:t>Body Shape</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`,
      );
      const buffer = await zip.generateAsync({ type: "uint8array" });

      const result = await pptxToMarkdown(buffer, "shapes.pptx");

      expect(result).toContain("Title Shape");
      expect(result).toContain("Body Shape");
    });

    it("handles multiple paragraphs in a single text body", async () => {
      const zip = new JSZip();
      zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
      );
      zip.file(
        "ppt/presentation.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}" xmlns:a="${A_NS}">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>`,
      );
      zip.file(
        "ppt/_rels/presentation.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
      );
      zip.file(
        "ppt/slides/slide1.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:p><a:r><a:t>First paragraph</a:t></a:r></a:p>
          <a:p><a:r><a:t>Second paragraph</a:t></a:r></a:p>
          <a:p><a:r><a:t>Third paragraph</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`,
      );
      const buffer = await zip.generateAsync({ type: "uint8array" });

      const result = await pptxToMarkdown(buffer, "multi-para.pptx");

      expect(result).toContain("First paragraph");
      expect(result).toContain("Second paragraph");
      expect(result).toContain("Third paragraph");
    });

    it("falls back to file listing when presentation.xml.rels is missing", async () => {
      const zip = new JSZip();
      zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
      );
      // presentation.xml exists with sldIdLst, but rels file is missing
      zip.file(
        "ppt/presentation.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}" xmlns:a="${A_NS}">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>`,
      );
      // No ppt/_rels/presentation.xml.rels — should fall back to file listing
      zip.file(
        "ppt/slides/slide2.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
      );
      zip.file(
        "ppt/slides/slide1.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>First</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
      );
      const buffer = await zip.generateAsync({ type: "uint8array" });

      const result = await pptxToMarkdown(buffer, "no-rels.pptx");

      const firstIdx = result.indexOf("First");
      const secondIdx = result.indexOf("Second");
      expect(firstIdx).toBeLessThan(secondIdx);
    });

    it("falls back to file listing when no presentation.xml", async () => {
      const zip = new JSZip();
      zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
      );
      // No presentation.xml, just slide files
      zip.file(
        "ppt/slides/slide2.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide Two</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
      );
      zip.file(
        "ppt/slides/slide1.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide One</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
      );
      const buffer = await zip.generateAsync({ type: "uint8array" });

      const result = await pptxToMarkdown(buffer, "fallback.pptx");

      // Should be ordered numerically (slide1 before slide2)
      const oneIdx = result.indexOf("Slide One");
      const twoIdx = result.indexOf("Slide Two");
      expect(oneIdx).toBeLessThan(twoIdx);
    });
  });
});
