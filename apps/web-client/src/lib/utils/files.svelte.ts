import { BaseDirectory, openFile } from "$lib/utils/tauri-loader";

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
 * Opens a file in the Downloads folder using the system default handler.
 * Tauri only - no-op in browser builds.
 */
export async function openInDownloads(filename: string): Promise<void> {
  if (!openFile || !BaseDirectory?.Download) return;
  try {
    await openFile(filename, { read: true, baseDir: BaseDirectory.Download });
  } catch (e) {
    console.error("Failed to open file:", e);
  }
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

/**
 * Gets a unique filename by appending -1, -2, etc. if the file already exists.
 * Tauri only - uses the fs plugin to check for existing files.
 */
export async function getUniqueFileName(baseName: string, baseDir: number): Promise<string> {
  const { exists } = await import("@tauri-apps/plugin-fs");

  const ext = baseName.includes(".") ? `.${baseName.split(".").pop()}` : "";
  const nameWithoutExt = ext ? baseName.slice(0, -ext.length) : baseName;

  if (!(await exists(baseName, { baseDir }))) {
    return baseName;
  }

  let counter = 1;
  while (true) {
    const newName = `${nameWithoutExt}-${counter}${ext}`;
    if (!(await exists(newName, { baseDir }))) {
      return newName;
    }
    counter++;
  }
}
