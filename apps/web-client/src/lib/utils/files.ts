/**
 * Downloads a JSON file to the user's computer.
 * @param filename The name of the file to download.
 * @param content The content of the file to download.
 */
export function downloadJson(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/json" });
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
 * Downloads a YAML file to the user's computer.
 * @param filename The name of the file to download.
 * @param content The content of the file to download.
 */
export function downloadYaml(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/yaml" });
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
 * Downloads a CSV file to the user's computer.
 * @param filename The name of the file to download.
 * @param content The content of the file to download.
 */
export function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
