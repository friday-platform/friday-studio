import { MAX_DECOMPRESSED_SIZE } from "@atlas/core/artifacts/file-upload";
import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import JSZip from "jszip";
import { ConverterError, elementAt } from "./xml-utils.ts";

const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * Converts a PPTX buffer to markdown. Filename is used as the document title.
 *
 * @throws ConverterError PASSWORD_PROTECTED | CORRUPTED | DECOMPRESSION_LIMIT
 */
export async function pptxToMarkdown(buffer: Uint8Array, filename: string): Promise<string> {
  let zip: JSZip;

  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new ConverterError("CORRUPTED", "This PPTX file appears to be corrupted or invalid.");
  }

  // Check for encrypted OOXML
  if (zip.file("EncryptedPackage")) {
    throw new ConverterError(
      "PASSWORD_PROTECTED",
      "This PPTX is password-protected. Remove the password and re-upload.",
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
          "PPTX decompressed content exceeds size limit.",
        );
      }
    }
  }

  // Get slide order from presentation.xml
  const slideOrder = await getSlideOrder(zip);

  if (slideOrder.length === 0) {
    return `# ${filename}\n\n> **Notice:** This PPTX contains no slides.`;
  }

  const slideSections: string[] = [];

  for (let i = 0; i < slideOrder.length; i++) {
    const slidePath = slideOrder[i];
    if (!slidePath) continue;

    const slideFile = zip.file(slidePath);
    if (!slideFile) continue;

    const xmlStr = await slideFile.async("string");
    const doc = new DOMParser().parseFromString(xmlStr, "text/xml");

    const texts = extractSlideText(doc);
    const slideText = texts.join("\n\n");

    slideSections.push(`## Slide ${i + 1}\n\n${slideText || "(empty slide)"}`);
  }

  const content = slideSections.join("\n\n");
  return `# ${filename}\n\n${content}`;
}

/**
 * Read ppt/presentation.xml and its relationships to determine slide order.
 * Falls back to alphabetical slide file listing if relationships aren't available.
 */
async function getSlideOrder(zip: JSZip): Promise<string[]> {
  const presXml = zip.file("ppt/presentation.xml");
  if (!presXml) {
    return fallbackSlideOrder(zip);
  }

  const presStr = await presXml.async("string");
  const presDoc = new DOMParser().parseFromString(presStr, "text/xml");

  // Get relationship IDs from p:sldIdLst > p:sldId elements
  const sldIdLst = presDoc.getElementsByTagNameNS(P_NS, "sldIdLst").item(0);
  if (!sldIdLst) {
    return fallbackSlideOrder(zip);
  }

  // Collect rIds in order
  const rIds: string[] = [];
  for (let i = 0; i < sldIdLst.childNodes.length; i++) {
    const sldId = elementAt(sldIdLst.childNodes, i);
    if (!sldId || sldId.localName !== "sldId") continue;
    const rId = sldId.getAttributeNS(R_NS, "id");
    if (rId) rIds.push(rId);
  }

  // Read presentation.xml.rels to map rIds to slide paths
  const relsFile = zip.file("ppt/_rels/presentation.xml.rels");
  if (!relsFile) {
    return fallbackSlideOrder(zip);
  }

  const relsStr = await relsFile.async("string");
  const relsDoc = new DOMParser().parseFromString(relsStr, "text/xml");

  const rIdToTarget = new Map<string, string>();
  const relationships = relsDoc.getElementsByTagName("Relationship");
  for (let i = 0; i < relationships.length; i++) {
    const rel = relationships.item(i);
    if (!rel) continue;
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) {
      // Target is relative to ppt/, e.g. "slides/slide1.xml"
      rIdToTarget.set(id, `ppt/${target}`);
    }
  }

  const orderedSlides: string[] = [];
  for (const rId of rIds) {
    const target = rIdToTarget.get(rId);
    if (target) orderedSlides.push(target);
  }

  return orderedSlides;
}

function fallbackSlideOrder(zip: JSZip): string[] {
  return Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const numA = Number.parseInt(a.match(/slide(\d+)/)?.[1] ?? "0", 10);
      const numB = Number.parseInt(b.match(/slide(\d+)/)?.[1] ?? "0", 10);
      return numA - numB;
    });
}

/**
 * Extract all text content from a slide XML document.
 * Walks through shapes (p:sp) and their text bodies (p:txBody).
 */
function extractSlideText(doc: Document): string[] {
  const texts: string[] = [];

  // Find all p:txBody elements (fallback for group shapes and other containers)
  const txBodies = doc.getElementsByTagNameNS(P_NS, "txBody");

  // Walk p:sp > p:txBody for the common case
  const spElements = doc.getElementsByTagNameNS(P_NS, "sp");
  const processedBodies = new Set<Element>();

  for (let i = 0; i < spElements.length; i++) {
    const sp = spElements.item(i);
    if (!sp) continue;

    for (let j = 0; j < sp.childNodes.length; j++) {
      const child = elementAt(sp.childNodes, j);
      if (!child || child.localName !== "txBody") continue;

      processedBodies.add(child);
      const shapeText = extractTextFromTxBody(child);
      if (shapeText) texts.push(shapeText);
    }
  }

  // Process any p:txBody not already covered (e.g. in group shapes)
  for (let i = 0; i < txBodies.length; i++) {
    const txBody = txBodies.item(i);
    if (!txBody || processedBodies.has(txBody)) continue;

    const shapeText = extractTextFromTxBody(txBody);
    if (shapeText) texts.push(shapeText);
  }

  return texts;
}

/**
 * Extract text from a single txBody element.
 * Processes a:p > a:r > a:t elements.
 */
function extractTextFromTxBody(txBody: Element): string {
  const paragraphs: string[] = [];

  for (let i = 0; i < txBody.childNodes.length; i++) {
    const p = elementAt(txBody.childNodes, i);
    if (!p || p.localName !== "p" || p.namespaceURI !== A_NS) continue;

    const runs: string[] = [];
    for (let j = 0; j < p.childNodes.length; j++) {
      const child = elementAt(p.childNodes, j);
      if (!child) continue;

      if (child.localName === "r") {
        // Extract text from a:t
        for (let k = 0; k < child.childNodes.length; k++) {
          const t = elementAt(child.childNodes, k);
          if (t && t.localName === "t" && t.namespaceURI === A_NS) {
            runs.push(t.textContent ?? "");
          }
        }
      } else if (child.localName === "br") {
        runs.push("\n");
      }
    }

    const paragraphText = runs.join("");
    if (paragraphText) paragraphs.push(paragraphText);
  }

  return paragraphs.join("\n");
}
