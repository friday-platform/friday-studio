/**
 * Utilities for opening files with system default applications
 */

import type { LibraryItem } from "@atlas/client";

/**
 * Determine file extension from library item metadata
 */
export function getFileExtensionFromLibraryItem(item: LibraryItem): string {
  // First check metadata.format which should contain the file format
  if (item.metadata.format) {
    const format = item.metadata.format.toLowerCase();

    // Handle common format mappings
    const formatToExtension: Record<string, string> = {
      "markdown": "md",
      "typescript": "ts",
      "javascript": "js",
      "python": "py",
      "yaml": "yml",
      "json": "json",
      "html": "html",
      "css": "css",
      "xml": "xml",
      "text": "txt",
      "plaintext": "txt",
      "pdf": "pdf",
      "png": "png",
      "jpg": "jpg",
      "jpeg": "jpg",
      "gif": "gif",
      "svg": "svg",
      "zip": "zip",
      "tar": "tar",
      "gz": "gz",
    };

    if (formatToExtension[format]) {
      return formatToExtension[format];
    }

    // If format doesn't match known mappings, use it as-is
    return format;
  }

  // Fallback: try to extract extension from item name
  if (item.name && item.name.includes(".")) {
    const parts = item.name.split(".");
    return parts[parts.length - 1].toLowerCase();
  }

  // Final fallback based on item type
  const typeToExtension: Record<string, string> = {
    "document": "md",
    "code": "txt",
    "config": "yml",
    "data": "json",
    "image": "png",
    "archive": "zip",
  };

  return typeToExtension[item.type] || "txt";
}

/**
 * Generate a temporary filename for a library item
 */
export function generateTempFilename(item: LibraryItem): string {
  const extension = getFileExtensionFromLibraryItem(item);
  const safeName = item.name.replace(/[^a-zA-Z0-9\-_\.]/g, "_");

  // If the name already has the correct extension, use it as-is
  if (safeName.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) {
    return safeName;
  }

  // Otherwise, append the extension
  return `${safeName}.${extension}`;
}

/**
 * Open file with system default application
 */
export async function openFileWithDefaultApp(
  filePath: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Determine the appropriate command based on the operating system
    let command: string[];

    switch (Deno.build.os) {
      case "windows":
        command = ["cmd", "/c", "start", `"${filePath}"`];
        break;
      case "darwin": // macOS
        command = ["open", filePath];
        break;
      case "linux":
        command = ["xdg-open", filePath];
        break;
      default:
        return {
          success: false,
          error: `Unsupported operating system: ${Deno.build.os}`,
        };
    }

    // Execute the command
    const process = new Deno.Command(command[0], {
      args: command.slice(1),
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stderr } = await process.output();

    if (code !== 0) {
      const errorText = new TextDecoder().decode(stderr);
      return {
        success: false,
        error: `Failed to open file: ${errorText}`,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Error opening file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Create a temporary file with content and open it
 */
export async function createTempFileAndOpen(
  item: LibraryItem,
  content: string | Uint8Array,
): Promise<{ success: boolean; error?: string; tempPath?: string }> {
  try {
    // Generate temporary file path
    const tempDir = await Deno.makeTempDir({ prefix: "atlas_library_" });
    const filename = generateTempFilename(item);
    const tempPath = `${tempDir}/${filename}`;

    // Write content to temporary file
    if (typeof content === "string") {
      await Deno.writeTextFile(tempPath, content);
    } else {
      await Deno.writeFile(tempPath, content);
    }

    // Open the file
    const openResult = await openFileWithDefaultApp(tempPath);

    if (!openResult.success) {
      // Clean up on failure
      try {
        await Deno.remove(tempPath);
        await Deno.remove(tempDir);
      } catch {
        // Ignore cleanup errors
      }
      return openResult;
    }

    return {
      success: true,
      tempPath,
    };
  } catch (error) {
    return {
      success: false,
      error: `Error creating temporary file: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
