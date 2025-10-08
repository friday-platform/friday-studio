/**
 * Browser-compatible replacements for Node.js APIs using Tauri
 */
import { invoke } from "@tauri-apps/api/core";

// Path operations - simple browser implementations
export const path = { join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/") };

// OS operations using Tauri
export const os = {
  homedir: async () => {
    return await invoke<string>("get_home_dir_string");
  },
  tmpdir: async () => {
    return await invoke<string>("get_temp_dir_string");
  },
};

// File system operations using Tauri
export const fs = {
  existsSync: async (path: string) => {
    return await invoke<boolean>("file_exists", { path });
  },
  mkdirSync: async (path: string, options?: { recursive?: boolean }) => {
    await invoke("create_directory", { path, recursive: options?.recursive ?? false });
  },
  unlinkSync: async (path: string) => {
    await invoke("remove_file", { path });
  },
  writeFileSync: async (path: string, data: string | Uint8Array) => {
    // Convert Buffer/Uint8Array to base64 for transmission
    const content = typeof data === "string" ? data : btoa(String.fromCharCode(...data));
    const isBinary = typeof data !== "string";
    await invoke("write_file", { path, content, isBinary });
  },
};

// Process utilities using Tauri
export async function safeExec(command: string, options: any = {}): Promise<string> {
  // For service start/daemon commands, don't hide windows (allows child process spawning)
  const hideWindow = options.hideWindow !== false;

  // Let the shell handle command parsing - much more reliable
  const result = await invoke<{ stdout: string; stderr: string; status: number }>(
    hideWindow ? "run_shell_command" : "run_shell_command_visible",
    { command },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || "Command failed");
  }

  return result.stdout;
}
