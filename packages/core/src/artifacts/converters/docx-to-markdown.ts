import { MAX_DECOMPRESSED_SIZE } from "@atlas/core/artifacts/file-upload";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { ConverterError, elementAt, getChildElement, hasChildElement } from "./xml-utils.ts";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/**
 * Converts a DOCX buffer to markdown. Filename is used as the document title.
 *
 * @throws ConverterError PASSWORD_PROTECTED | CORRUPTED | DECOMPRESSION_LIMIT
 */
export async function docxToMarkdown(buffer: Uint8Array, filename: string): Promise<string> {
  let zip: JSZip;

  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new ConverterError("CORRUPTED", "This DOCX file appears to be corrupted or invalid.");
  }

  // Check for encrypted OOXML (EncryptedPackage signals password protection)
  if (zip.file("EncryptedPackage")) {
    throw new ConverterError(
      "PASSWORD_PROTECTED",
      "This DOCX is password-protected. Remove the password and re-upload.",
    );
  }

  // Decompression guard: sum all file sizes before parsing
  let totalSize = 0;
  for (const relativePath of Object.keys(zip.files)) {
    const entry = zip.files[relativePath];
    if (entry && !entry.dir) {
      const data = await entry.async("uint8array");
      totalSize += data.byteLength;
      if (totalSize > MAX_DECOMPRESSED_SIZE) {
        throw new ConverterError(
          "DECOMPRESSION_LIMIT",
          "DOCX decompressed content exceeds size limit.",
        );
      }
    }
  }

  const documentXml = zip.file("word/document.xml");
  if (!documentXml) {
    throw new ConverterError("CORRUPTED", "This DOCX file appears to be corrupted or invalid.");
  }

  const xmlStr = await documentXml.async("string");
  const doc = new DOMParser().parseFromString(xmlStr, "text/xml");

  const body = doc.getElementsByTagNameNS(W_NS, "body").item(0);
  if (!body) {
    return `# ${filename}\n\n> **Notice:** This DOCX contains no readable content.`;
  }

  const lines: string[] = [];

  for (let i = 0; i < body.childNodes.length; i++) {
    const el = elementAt(body.childNodes, i);
    if (!el) continue;

    if (el.localName === "tbl") {
      const tableMarkdown = parseTable(el);
      if (tableMarkdown) lines.push(tableMarkdown);
    } else if (el.localName === "p") {
      const line = parseParagraph(el);
      if (line !== null) lines.push(line);
    }
  }

  const content = lines.join("\n\n");
  if (content.replace(/\s+/g, "").length < 15) {
    return `# ${filename}\n\n> **Notice:** This DOCX contains no readable text content.`;
  }

  return `# ${filename}\n\n${content}`;
}

function parseParagraph(p: Element): string | null {
  // Check paragraph style for heading
  const pPr = getChildElement(p, W_NS, "pPr");
  let headingLevel = 0;
  let isListItem = false;

  if (pPr) {
    const pStyle = getChildElement(pPr, W_NS, "pStyle");
    if (pStyle) {
      // getAttributeNS can be unreliable in xmldom for prefixed attributes — fallback to getAttribute
      const val = pStyle.getAttributeNS(W_NS, "val") ?? pStyle.getAttribute("w:val") ?? "";
      const headingMatch = val.match(/^Heading([1-6])$/);
      if (headingMatch) {
        headingLevel = Number.parseInt(headingMatch[1] ?? "0", 10);
      }
    }

    // Check for list items
    const numPr = getChildElement(pPr, W_NS, "numPr");
    if (numPr) {
      isListItem = true;
    }
  }

  // Collect runs
  const textParts: string[] = [];
  for (let i = 0; i < p.childNodes.length; i++) {
    const child = elementAt(p.childNodes, i);
    if (!child) continue;

    if (child.localName === "r") {
      textParts.push(parseRun(child));
    } else if (child.localName === "hyperlink") {
      // Process runs inside hyperlinks
      for (let j = 0; j < child.childNodes.length; j++) {
        const hChild = elementAt(child.childNodes, j);
        if (hChild && hChild.localName === "r") {
          textParts.push(parseRun(hChild));
        }
      }
    }
  }

  const text = textParts.join("");
  if (!text) return null;

  if (headingLevel > 0 && headingLevel <= 6) {
    return `${"#".repeat(headingLevel)} ${text}`;
  }

  if (isListItem) {
    return `- ${text}`;
  }

  return text;
}

function parseRun(r: Element): string {
  // Check run properties for bold/italic
  const rPr = getChildElement(r, W_NS, "rPr");
  let bold = false;
  let italic = false;

  if (rPr) {
    bold = hasChildElement(rPr, W_NS, "b");
    italic = hasChildElement(rPr, W_NS, "i");
  }

  // Collect text
  const texts: string[] = [];
  for (let i = 0; i < r.childNodes.length; i++) {
    const child = elementAt(r.childNodes, i);
    if (!child) continue;

    if (child.localName === "t") {
      texts.push(child.textContent ?? "");
    } else if (child.localName === "tab") {
      texts.push("\t");
    } else if (child.localName === "br") {
      texts.push("\n");
    }
  }

  let text = texts.join("");
  if (!text) return "";

  if (bold && italic) {
    text = `***${text}***`;
  } else if (bold) {
    text = `**${text}**`;
  } else if (italic) {
    text = `*${text}*`;
  }

  return text;
}

function parseTable(tbl: Element): string {
  const rows: string[][] = [];

  for (let i = 0; i < tbl.childNodes.length; i++) {
    const tr = elementAt(tbl.childNodes, i);
    if (!tr || tr.localName !== "tr") continue;

    const cells: string[] = [];
    for (let j = 0; j < tr.childNodes.length; j++) {
      const tc = elementAt(tr.childNodes, j);
      if (!tc || tc.localName !== "tc") continue;

      // Collect text from all paragraphs in the cell
      const cellTexts: string[] = [];
      for (let k = 0; k < tc.childNodes.length; k++) {
        const p = elementAt(tc.childNodes, k);
        if (!p || p.localName !== "p") continue;
        const text = parseParagraph(p);
        if (text) cellTexts.push(text);
      }
      cells.push(cellTexts.join(" "));
    }
    rows.push(cells);
  }

  if (rows.length === 0) return "";

  const headerRow = rows[0];
  if (!headerRow) return "";

  const escapeCell = (text: string): string => text.replaceAll("|", "\\|");

  const mdLines: string[] = [];
  mdLines.push(`| ${headerRow.map(escapeCell).join(" | ")} |`);
  mdLines.push(`| ${headerRow.map(() => "---").join(" | ")} |`);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    // Pad row to match header column count
    while (row.length < headerRow.length) row.push("");
    mdLines.push(`| ${row.map(escapeCell).join(" | ")} |`);
  }

  return mdLines.join("\n");
}
