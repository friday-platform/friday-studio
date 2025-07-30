import { join } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { getAtlasHome, getAtlasLogsDir } from "./paths.ts";
import { walk } from "@std/fs";
import { TarStream, type TarStreamInput } from "@std/tar/tar-stream";
import { getAtlasClient } from "@atlas/client";
import { stringify } from "@std/yaml";
import { getVersionInfo } from "./version.ts";

export class DiagnosticsCollector {
  private tempDir: string;

  constructor() {
    // Create temp directory directly without subdirectory
    this.tempDir = Deno.makeTempDirSync({ prefix: "atlas-diagnostics-" });
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
    await this.collectSystemWorkspaces();

    // Create tar.gz archive
    const gzipPath = join(Deno.makeTempDirSync(), "diagnostics.tar.gz");
    await this.createTarGzArchive(gzipPath);

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
              const workspace = entry.value as { id?: string; name: string; path: string };
              const workspaceYmlPath = join(workspace.path, "workspace.yml");

              try {
                // Create workspace subdirectory
                const workspaceDir = join(this.tempDir, "workspaces", workspace.name);
                await ensureDir(workspaceDir);

                // Copy workspace.yml if it exists
                let hasYamlFile = false;
                if (await exists(workspaceYmlPath)) {
                  await Deno.copyFile(workspaceYmlPath, join(workspaceDir, "workspace.yml"));
                  hasYamlFile = true;
                }

                // If no YAML file, try to fetch runtime configuration
                if (!hasYamlFile && workspace.id) {
                  try {
                    const client = getAtlasClient({ timeout: 5000 });
                    const workspaceDetails = await client.getWorkspace(workspace.id);

                    if (workspaceDetails.config) {
                      // Save runtime config as YAML
                      const yamlContent = stringify(workspaceDetails.config);
                      const configPath = join(workspaceDir, "runtime-config.yml");
                      await Deno.writeTextFile(configPath, yamlContent);

                      // Also save a note explaining this is runtime config
                      const notePath = join(workspaceDir, "README.txt");
                      await Deno.writeTextFile(
                        notePath,
                        `This workspace configuration was fetched from the runtime.\n` +
                          `Workspace ID: ${workspace.id}\n` +
                          `Name: ${workspace.name}\n` +
                          `Path: ${workspace.path}\n` +
                          `Status: ${workspaceDetails.status || "unknown"}\n`,
                      );
                    }
                  } catch (err) {
                    console.warn(
                      `Failed to fetch runtime config for ${workspace.name}:`,
                      err instanceof Error ? err.message : String(err),
                    );
                  }
                } else if (!hasYamlFile && !workspace.id) {
                  // No YAML file and no ID to fetch runtime config
                  const notePath = join(workspaceDir, "NO_CONFIG.txt");
                  await Deno.writeTextFile(
                    notePath,
                    `This workspace has no workspace.yml file and no workspace ID for fetching runtime config.\n` +
                      `Name: ${workspace.name}\n` +
                      `Path: ${workspace.path}\n`,
                  );
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

          // Also collect draft workspaces from KV
          await this.collectDraftWorkspaces(kv);
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

  private async collectSystemWorkspaces(): Promise<void> {
    try {
      // Create system-workspaces directory
      const systemDir = join(this.tempDir, "system-workspaces");
      await ensureDir(systemDir);

      // Try to dynamically import system workspaces
      try {
        const { SYSTEM_WORKSPACES } = await import("@packages/system/workspaces");

        for (const [id, config] of Object.entries(SYSTEM_WORKSPACES)) {
          try {
            const workspaceDir = join(systemDir, id);
            await ensureDir(workspaceDir);

            // Save as YAML
            const yamlContent = stringify(config);
            const yamlPath = join(workspaceDir, "system-config.yml");
            await Deno.writeTextFile(yamlPath, yamlContent);

            // Save metadata
            const metaPath = join(workspaceDir, "README.txt");
            await Deno.writeTextFile(
              metaPath,
              `System workspace: ${id}\n` +
                `This is a built-in system workspace embedded in the Atlas binary.\n`,
            );
          } catch (err) {
            console.warn(
              `Failed to save system workspace ${id}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      } catch (err) {
        // If we can't import system workspaces (e.g., running from source vs compiled),
        // try to read them from the filesystem
        const systemWorkspacesPath = join(
          Deno.cwd(),
          "packages/system/workspaces",
        );

        if (await exists(systemWorkspacesPath)) {
          // Copy all YAML files from system workspaces directory
          for await (const entry of Deno.readDir(systemWorkspacesPath)) {
            if (entry.isFile && entry.name.endsWith(".yml")) {
              try {
                const sourcePath = join(systemWorkspacesPath, entry.name);
                const destPath = join(systemDir, entry.name);
                await Deno.copyFile(sourcePath, destPath);
              } catch (err) {
                console.warn(
                  `Failed to copy system workspace ${entry.name}:`,
                  err instanceof Error ? err.message : String(err),
                );
              }
            }
          }

          // Add a note about system workspaces
          const notePath = join(systemDir, "README.txt");
          await Deno.writeTextFile(
            notePath,
            `System workspaces are built-in workspaces that come with Atlas.\n` +
              `These YAML files define the system workspace configurations.\n`,
          );
        }
      }
    } catch (err) {
      console.warn(
        "Failed to collect system workspaces:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async collectDraftWorkspaces(kv: Deno.Kv): Promise<void> {
    try {
      // Create drafts directory
      const draftsDir = join(this.tempDir, "drafts");
      await ensureDir(draftsDir);

      // List all drafts from KV
      const drafts = kv.list({ prefix: ["drafts"] });
      let draftCount = 0;

      for await (const entry of drafts) {
        if (entry.value && typeof entry.value === "object") {
          draftCount++;
          const draft = entry.value as any;
          const draftId = entry.key[entry.key.length - 1] as string;

          try {
            // Create draft subdirectory
            const draftDir = join(draftsDir, draftId);
            await ensureDir(draftDir);

            // Save draft data as JSON
            const draftPath = join(draftDir, "draft.json");
            await Deno.writeTextFile(draftPath, JSON.stringify(draft, null, 2));

            // If draft has config, also save as YAML
            if (draft.config) {
              const yamlPath = join(draftDir, "draft-config.yml");
              const yamlContent = stringify(draft.config);
              await Deno.writeTextFile(yamlPath, yamlContent);
            }
          } catch (err) {
            console.warn(
              `Failed to collect draft ${draftId}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }

      if (draftCount > 0) {
        // Save summary of drafts
        const summaryPath = join(draftsDir, "README.txt");
        await Deno.writeTextFile(
          summaryPath,
          `Found ${draftCount} draft workspace(s) in KV storage.\n` +
            `Each draft directory contains the full draft data.\n`,
        );
      }
    } catch (err) {
      console.warn(
        "Failed to collect draft workspaces:",
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

  private async createTarGzArchive(outputPath: string): Promise<void> {
    // Create metadata file
    const metadataPath = join(this.tempDir, "metadata.json");
    const versionInfo = getVersionInfo();
    const metadata = {
      timestamp: new Date().toISOString(),
      atlasVersion: versionInfo.version,
      gitSha: versionInfo.gitSha || undefined,
      channel: versionInfo.channel,
      isCompiled: versionInfo.isCompiled,
      isDev: versionInfo.isDev,
      platform: Deno.build.os,
      denoVersion: Deno.version.deno,
    };
    await Deno.writeTextFile(metadataPath, JSON.stringify(metadata, null, 2));

    // Convert directory to tar stream entries
    const tarEntries = await this.createTarStreamEntries(this.tempDir);

    // Create the output file
    const outputFile = await Deno.open(outputPath, { write: true, create: true });

    try {
      // Create tar.gz archive using streaming API
      await ReadableStream.from(tarEntries)
        .pipeThrough(new TarStream())
        .pipeThrough(new CompressionStream("gzip"))
        .pipeTo(outputFile.writable);
    } catch (error) {
      // Close file on error
      outputFile.close();
      throw error;
    }
    // Note: File is automatically closed when writable stream completes

    // Clean up temp directory
    await Deno.remove(this.tempDir, { recursive: true });
  }

  private async createTarStreamEntries(baseDir: string): Promise<TarStreamInput[]> {
    const entries: TarStreamInput[] = [];
    const baseDirPath = baseDir.endsWith("/") ? baseDir : baseDir + "/";

    // Walk through all files and directories
    for await (const entry of walk(baseDir)) {
      // Skip the base directory itself
      if (entry.path === baseDir) continue;

      const relativePath = entry.path.replace(baseDirPath, "");

      // Double-check we have a valid relative path
      if (!relativePath || relativePath.startsWith("/")) continue;

      if (entry.isDirectory) {
        // Add directory entry
        entries.push({
          type: "directory",
          path: relativePath + "/",
        });
      } else if (entry.isFile) {
        try {
          const stat = await Deno.stat(entry.path);
          const file = await Deno.open(entry.path, { read: true });

          entries.push({
            type: "file",
            path: relativePath,
            size: stat.size,
            readable: file.readable,
          });
        } catch (err) {
          console.warn(
            `Failed to add ${relativePath} to tar:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    return entries;
  }
}
