/**
 * File path detection utilities for terminal file attachments
 * These functions detect and extract information from file paths pasted into the terminal
 */

// Path patterns for different operating systems
// These patterns must match COMPLETE paths only (no text before or after)
export const UNIX_PATH_PATTERNS = [
  /^\/(?:[^\s]+(?:\\ [^\s]+)*)?$/, // Absolute paths with optional escaped spaces
  /^\/[^\s]+(?:\/[^\s]+)*\/?$/, // Standard absolute paths
  /^~\/[^\s]+(?:\/[^\s]+)*\/?$/, // Home directory paths
  /^\.{1,2}\/[^\s]+(?:\/[^\s]+)*\/?$/, // Relative paths (. or ..)
];

export const WINDOWS_PATH_PATTERNS = [
  /^[A-Za-z]:[\\/].*$/, // Drive letter paths (allow spaces)
  /^\\\\.*$/, // UNC paths (allow spaces)
];

/**
 * Check if a string matches any pattern in an array of regex patterns
 */
export function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Extract the file or folder name from a path
 * Handles both Unix and Windows path formats
 */
export function extractFileName(path: string): string {
  // First handle escaped spaces
  let cleanPath = path.replace(/\\ /g, " ");

  // Remove trailing slashes
  cleanPath = cleanPath.replace(/[/\\]+$/, "");

  // Split by both forward and back slashes
  const segments = cleanPath.split(/[/\\]/);

  // Get the last non-empty segment
  const lastSegment = segments.filter((s) => s.length > 0).pop();

  return lastSegment || "unknown";
}

/**
 * Determine if a path has a file extension
 * Used to distinguish between files and directories
 * Dotfiles without extensions (e.g., .gitignore) are not considered to have extensions
 */
export function hasFileExtension(path: string): boolean {
  const fileName = extractFileName(path);
  // Don't count dotfiles as having extensions (e.g., .gitignore, .config)
  if (fileName.startsWith(".") && !fileName.includes(".", 1)) {
    return false;
  }
  return /\.[a-zA-Z0-9]+$/.test(fileName);
}

/**
 * Detect if a string is a file path based on OS-specific patterns
 */
export function isFilePath(text: string, os?: "darwin" | "linux" | "windows"): boolean {
  // Default to treating non-windows systems as unix-like
  const effectiveOs = os || (Deno.build.os === "windows" ? "windows" : "darwin");
  const patterns = effectiveOs === "windows" ? WINDOWS_PATH_PATTERNS : UNIX_PATH_PATTERNS;
  return matchesAnyPattern(text, patterns);
}

/**
 * Extract all file paths from a text string
 * Returns an array of detected file paths
 * IMPORTANT: Only detects paths that occupy an ENTIRE line by themselves
 */
export function extractFilePaths(text: string): string[] {
  // Always check for both Unix and Windows paths regardless of OS
  // This allows detecting Windows paths on Unix and vice versa
  const patterns = [...UNIX_PATH_PATTERNS, ...WINDOWS_PATH_PATTERNS];

  // Split by newlines to check each line individually
  const lines = text.split(/\n/);
  const paths: string[] = [];

  for (const line of lines) {
    // Check if the ENTIRE line is a path (no other text)
    const trimmedLine = line.trim();
    if (trimmedLine && matchesAnyPattern(trimmedLine, patterns)) {
      paths.push(trimmedLine);
    }
    // Do NOT extract paths embedded within lines
  }

  return paths;
}

/**
 * Create a file attachment placeholder for display in the terminal
 */
export function createFileAttachmentPlaceholder(
  path: string,
  id: number,
  os?: "darwin" | "linux" | "windows",
): string {
  const effectiveOs = os || (Deno.build.os === "windows" ? "windows" : "darwin");
  const fileName = extractFileName(path);
  const isDirectory = !hasFileExtension(path);

  if (isDirectory) {
    // Add OS-specific directory indicator
    const separator = effectiveOs === "windows" ? "\\" : "/";
    return `[#${id} ${fileName}${separator}]`;
  } else {
    // Regular file, no suffix
    return `[#${id} ${fileName}]`;
  }
}

/**
 * Detect file paths in pasted content and return structured data
 */
export interface DetectedPath {
  originalText: string;
  fileName: string;
  isDirectory: boolean;
  hasExtension: boolean;
  extension?: string;
}

export function detectFilePaths(text: string): DetectedPath[] {
  const paths = extractFilePaths(text);

  return paths.map((path) => {
    const fileName = extractFileName(path);
    const hasExt = hasFileExtension(path);
    const extension = hasExt ? fileName.split(".").pop() : undefined;

    return { originalText: path, fileName, isDirectory: !hasExt, hasExtension: hasExt, extension };
  });
}
