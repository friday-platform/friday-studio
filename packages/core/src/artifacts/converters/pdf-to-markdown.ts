import { PDF } from "@libpdf/core";
import { ConverterError } from "./xml-utils.ts";

/**
 * Converts a PDF buffer to markdown format.
 *
 * @param buffer - PDF file contents as a Uint8Array (or Buffer)
 * @param filename - Original filename (used as document title)
 * @returns Promise resolving to markdown string with page headers
 * @throws ConverterError with PASSWORD_PROTECTED for encrypted PDFs
 * @throws ConverterError with CORRUPTED for corrupt PDFs
 */
export async function pdfToMarkdown(buffer: Uint8Array, filename: string): Promise<string> {
  let pdf: PDF;

  try {
    pdf = await PDF.load(buffer);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "";

    // Authentication errors indicate encrypted/password-protected PDFs
    if (errorName === "AuthenticationError") {
      throw new ConverterError(
        "PASSWORD_PROTECTED",
        "This PDF is password-protected. Remove the password and re-upload.",
      );
    }

    // Unrecoverable parse errors indicate corrupted PDFs
    if (errorName === "UnrecoverableParseError") {
      throw new ConverterError("CORRUPTED", "This PDF appears to be corrupted or invalid.");
    }

    throw error;
  }

  // Check for encrypted PDF that loaded but requires authentication
  if (pdf.isEncrypted && !pdf.isAuthenticated) {
    throw new ConverterError(
      "PASSWORD_PROTECTED",
      "This PDF is password-protected. Remove the password and re-upload.",
    );
  }

  // Extract text from all pages
  const allPages = pdf.extractText();

  // Build markdown with page headers
  const pageTexts: string[] = [];
  for (let i = 0; i < allPages.length; i++) {
    const page = allPages[i];
    if (page) {
      const pageText = page.text.trim();
      pageTexts.push(`## Page ${i + 1}\n\n${pageText}`);
    }
  }

  const markdown = pageTexts.join("\n\n");

  // Check for truly empty extraction (scanned/image-only PDFs)
  const contentOnly = markdown.replace(/## Page \d+/g, "").replace(/\s+/g, "");
  if (contentOnly.length < 15) {
    return `# ${filename}\n\n> **Notice:** This PDF contains primarily images or scanned content. No readable text found.`;
  }

  return `# ${filename}\n\n${markdown}`;
}
