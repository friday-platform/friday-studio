/**
 * Formats a file size in bytes to a human-readable string.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Downloads a file to the user's computer.
 * @param filename The name of the file to download.
 * @param content The content of the file to download.
 * @param mimeType The MIME type of the file.
 */
export function downloadFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Downloads a file from a URL by creating a temporary anchor element.
 * Triggers browser download without navigating away from current page.
 * @param url The URL to download from (should have Content-Disposition: attachment header)
 * @param filename Optional filename hint (ignored if server provides Content-Disposition)
 */
export function downloadFromUrl(url: string, filename?: string) {
  const a = document.createElement("a");
  a.href = url;
  if (filename) {
    a.download = filename;
  }
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export async function copyToClipboard(text: string | Array<string | null>) {
  try {
    const contents = Array.isArray(text) ? text.filter(Boolean).join("\n") : text;
    await navigator.clipboard.writeText(contents);
  } catch (e) {
    console.warn(e);
    alert("Unable to copy.");
  }
}
