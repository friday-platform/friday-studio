// Shared XML utilities for OOXML converters (DOCX, PPTX).

/**
 * Get an element child node from a NodeList by index.
 * Returns null for non-element nodes (text, comments, etc.).
 *
 * xmldom's TS types for ChildNode don't include localName/namespaceURI,
 * but nodeType === 1 guarantees the node is an Element at runtime.
 */
export function elementAt(nodes: NodeListOf<ChildNode>, index: number): Element | null {
  const node = nodes.item(index);
  if (!node || node.nodeType !== 1) return null;
  return node as unknown as Element;
}

/** Find the first child element matching namespace + localName. */
export function getChildElement(parent: Element, ns: string, localName: string): Element | null {
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = elementAt(parent.childNodes, i);
    if (child && child.localName === localName && child.namespaceURI === ns) {
      return child;
    }
  }
  return null;
}

/** Check whether a child element matching namespace + localName exists. */
export function hasChildElement(parent: Element, ns: string, localName: string): boolean {
  return getChildElement(parent, ns, localName) !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Converter error codes
// ─────────────────────────────────────────────────────────────────────────────

export type ConverterErrorCode = "PASSWORD_PROTECTED" | "CORRUPTED" | "DECOMPRESSION_LIMIT";

/**
 * Typed error for document converter failures.
 * Route handlers check `error.code` instead of matching on message strings.
 */
export class ConverterError extends Error {
  readonly code: ConverterErrorCode;

  constructor(code: ConverterErrorCode, message: string) {
    super(message);
    this.name = "ConverterError";
    this.code = code;
  }
}

/** Error codes that should be surfaced to the user as-is. */
export const USER_FACING_ERROR_CODES = new Set<ConverterErrorCode>([
  "PASSWORD_PROTECTED",
  "CORRUPTED",
]);
