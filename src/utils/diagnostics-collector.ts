import { join } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { getAtlasHome, getAtlasLogsDir } from "./paths.ts";
import { walk } from "@std/fs";

export class DiagnosticsCollector {
  private tempDir: string;

  constructor() {
    this.tempDir = join(Deno.makeTempDirSync(), "atlas-diagnostics");
  }

  async collectAndArchive(): Promise<string> {
    // Create directory structure
    await ensureDir(join(this.tempDir, "logs"));
    await ensureDir(join(this.tempDir, "memory"));
    await ensureDir(join(this.tempDir, "storage"));
    await ensureDir(join(this.tempDir, "workspaces"));

    // Collect data
    await this.collectLogs();
    await this.collectMemory();
    await this.collectStorage();
    await this.collectWorkspaces();

    // Create gzip archive
    const gzipPath = join(Deno.makeTempDirSync(), "diagnostics.gz");
    await this.createGzipArchive(gzipPath);

    return gzipPath;
  }

  private async collectLogs(): Promise<void> {
    const logsDir = getAtlasLogsDir();
    try {
      if (await exists(logsDir)) {
        await this.copyDirectory(logsDir, join(this.tempDir, "logs"));
      }
    } catch (err) {
      console.warn("Failed to collect logs:", err instanceof Error ? err.message : String(err));
    }
  }

  private async collectMemory(): Promise<void> {
    const memoryDir = join(getAtlasHome(), "memory");
    try {
      if (await exists(memoryDir)) {
        await this.copyDirectory(memoryDir, join(this.tempDir, "memory"));
      }
    } catch (err) {
      console.warn("Failed to collect memory:", err instanceof Error ? err.message : String(err));
    }
  }

  private async collectStorage(): Promise<void> {
    const storageFiles = ["storage.db", "storage.db-shm", "storage.db-wal"];
    const storageDir = join(this.tempDir, "storage");
    await ensureDir(storageDir);

    for (const file of storageFiles) {
      const sourcePath = join(getAtlasHome(), file);
      const destPath = join(storageDir, file);
      try {
        if (await exists(sourcePath)) {
          await Deno.copyFile(sourcePath, destPath);
        }
      } catch (err) {
        console.warn(
          `Failed to collect ${file}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  private async collectWorkspaces(): Promise<void> {
    // Open KV storage to get workspace paths
    const kvPath = join(getAtlasHome(), "storage.db");

    try {
      if (await exists(kvPath)) {
        const kv = await Deno.openKv(kvPath);

        try {
          // List all workspaces from KV
          const workspaces = kv.list({ prefix: ["workspaces"] });

          for await (const entry of workspaces) {
            if (
              entry.value && typeof entry.value === "object" && "path" in entry.value &&
              "name" in entry.value
            ) {
              const workspace = entry.value as { name: string; path: string };
              const workspaceYmlPath = join(workspace.path, "workspace.yml");

              try {
                // Create workspace subdirectory
                const workspaceDir = join(this.tempDir, "workspaces", workspace.name);
                await ensureDir(workspaceDir);

                // Copy workspace.yml
                if (await exists(workspaceYmlPath)) {
                  await Deno.copyFile(workspaceYmlPath, join(workspaceDir, "workspace.yml"));
                }

                // Also collect workspace runtime logs if available
                const workspaceLogsDir = join(getAtlasLogsDir(), "workspaces", workspace.name);
                if (await exists(workspaceLogsDir)) {
                  const workspaceLogsDest = join(workspaceDir, "logs");
                  await this.copyDirectory(workspaceLogsDir, workspaceLogsDest);
                }
              } catch (err) {
                console.warn(
                  `Failed to collect workspace ${workspace.name}:`,
                  err instanceof Error ? err.message : String(err),
                );
              }
            }
          }
        } finally {
          kv.close();
        }
      }
    } catch (err) {
      console.warn(
        "Failed to collect workspaces from KV:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async copyDirectory(source: string, dest: string): Promise<void> {
    await ensureDir(dest);

    for await (const entry of Deno.readDir(source)) {
      const sourcePath = join(source, entry.name);
      const destPath = join(dest, entry.name);

      if (entry.isDirectory) {
        await this.copyDirectory(sourcePath, destPath);
      } else {
        try {
          await Deno.copyFile(sourcePath, destPath);
        } catch (err) {
          console.warn(
            `Failed to copy ${entry.name}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }

  private async createGzipArchive(outputPath: string): Promise<void> {
    // Create a JSON structure with all collected data
    const diagnosticData: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      atlasVersion: Deno.env.get("ATLAS_VERSION") || "unknown",
      platform: Deno.build.os,
      files: {},
    };

    // Walk through all collected files and add them to the data structure
    for await (const entry of walk(this.tempDir)) {
      if (entry.isFile) {
        const relativePath = entry.path.replace(this.tempDir + "/", "");
        try {
          const content = await Deno.readTextFile(entry.path);
          diagnosticData.files[relativePath] = content;
        } catch {
          // If can't read as text, try binary
          try {
            const content = await Deno.readFile(entry.path);
            diagnosticData.files[relativePath] = btoa(String.fromCharCode(...content));
          } catch (err) {
            console.warn(
              `Failed to read ${relativePath}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }
    }

    // Convert to JSON and compress
    const jsonData = JSON.stringify(diagnosticData, null, 2);
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(jsonData);

    // Use native CompressionStream to gzip the data
    const compressed = await this.compressData(dataBytes);

    // Write compressed data
    await Deno.writeFile(outputPath, compressed);

    // Clean up temp directory
    await Deno.remove(this.tempDir, { recursive: true });
  }

  private async compressData(data: Uint8Array): Promise<Uint8Array> {
    // Create a readable stream from the data
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });

    // Pipe through compression stream
    const compressed = readable.pipeThrough(new CompressionStream("gzip"));

    // Collect compressed chunks
    const chunks: Uint8Array[] = [];
    const reader = compressed.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    // Combine chunks into single Uint8Array
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }
}
