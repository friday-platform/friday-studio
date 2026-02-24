import { access } from "node:fs/promises";

/**
 * Check if a file or directory exists at the given path.
 */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
