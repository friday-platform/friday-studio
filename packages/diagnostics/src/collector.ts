import { readdir, readFile, writeFile } from "node:fs/promises";
import { env } from "node:process";
import { getAtlasClient } from "@atlas/client";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import type { WorkspaceEntry } from "@atlas/workspace";
import { ensureDir, exists, walk } from "@std/fs";
import { join } from "@std/path";
import { TarStream, type TarStreamInput } from "@std/tar/tar-stream";
import { stringify } from "@std/yaml";
import { z } from "zod";
import { collectOpenFiles } from "./open-files/collector.ts";
import { getAtlasLogsDir } from "./paths.ts";
import { ReleaseChannel } from "./release-channel.ts";

const log = createLogger({ component: "diagnostics-collector" });

export interface VersionInfo {
  version: string;
  gitSha?: string;
  isNightly: boolean;
  isDev: boolean;
  isCompiled: boolean;
}

export interface ServiceStatus {
  running: boolean;
  pid?: number;
}

export interface DiagnosticsCollectorOptions {
  getServiceStatus?: () => Promise<ServiceStatus>;
  versionInfo?: VersionInfo;
}

export class DiagnosticsCollector {
  private tempDir: string;
  private options: DiagnosticsCollectorOptions;

  constructor(options: DiagnosticsCollectorOptions = {}) {
    this.options = options;
    // Create temp directory directly without subdirectory
    this.tempDir = Deno.makeTempDirSync({ prefix: "atlas-diagnostics-" });
  }

  async collectAndArchive(): Promise<string> {
    // Create directory structure
    await ensureDir(join(this.tempDir, "logs"));
    await ensureDir(join(this.tempDir, "memory"));
    await ensureDir(join(this.tempDir, "storage"));
    await ensureDir(join(this.tempDir, "chats"));
    await ensureDir(join(this.tempDir, "workspaces"));
    await ensureDir(join(this.tempDir, "artifacts"));

    // Collect data
    log.info("Collecting logs...");
    await this.collectLogs();

    log.info("Collecting memory data...");
    await this.collectMemory();

    log.info("Collecting storage data...");
    await this.collectStorage();

    log.info("Collecting chat data...");
    await this.collectChats();

    log.info("Collecting workspace configurations...");
    await this.collectWorkspaces();
    await this.collectSystemWorkspaces();

    log.info("Collecting artifacts...");
    await this.collectArtifacts();

    log.info("Collecting open file handles...");
    await this.collectOpenFiles();

    // Create tar.gz archive
    log.info("Creating compressed archive...");
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
    } catch (error) {
      log.warn("Failed to collect logs:", { error });
    }
  }

  private async collectMemory(): Promise<void> {
    const memoryDir = join(getAtlasHome(), "memory");
    try {
      if (await exists(memoryDir)) {
        await this.copyDirectory(memoryDir, join(this.tempDir, "memory"), [".cache"]);
      }
    } catch (error) {
      log.warn("Failed to collect memory:", { error });
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
      } catch (error) {
        log.warn(`Failed to collect ${file}:`, { error });
      }
    }
  }

  private async collectChats(): Promise<void> {
    const chatsDir = join(getAtlasHome(), "chats");
    try {
      if (await exists(chatsDir)) {
        await this.copyDirectory(chatsDir, join(this.tempDir, "chats"));
      }
    } catch (error) {
      log.warn("Failed to collect chats:", { error });
    }
  }

  private async collectArtifacts(): Promise<void> {
    const artifactsDir = join(getAtlasHome(), "artifacts");
    try {
      if (await exists(artifactsDir)) {
        await this.copyDirectory(artifactsDir, join(this.tempDir, "artifacts"));
      }
    } catch (error) {
      log.warn("Failed to collect artifacts:", { error });
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
          const workspaces = kv.list<WorkspaceEntry>({ prefix: ["workspaces"] });

          for await (const entry of workspaces) {
            // Only process actual workspace entries: ["workspaces", "<workspace-id>"]
            // This filters out metadata entries like ["workspaces", "_list"]
            if (entry.key.length !== 2 || entry.key[0] !== "workspaces") {
              continue;
            }

            const workspace = entry.value;

            // Skip workspaces with missing required fields (corrupted data)
            if (!workspace?.name || !workspace?.path) {
              log.warn(`Skipping workspace with invalid data:`, {
                key: entry.key,
                value: workspace,
                reason: !workspace?.name ? "missing name" : "missing path",
              });
              continue;
            }

            try {
              // Create workspace subdirectory
              const workspaceDir = join(this.tempDir, "workspaces", workspace.name);
              await ensureDir(workspaceDir);

              // Copy workspace.yml if it exists (skip for system workspaces)
              let hasYamlFile = false;
              const isSystemWorkspace = workspace.path.startsWith("system://");

              if (!isSystemWorkspace) {
                const workspaceYmlPath = join(workspace.path, "workspace.yml");
                if (await exists(workspaceYmlPath)) {
                  await Deno.copyFile(workspaceYmlPath, join(workspaceDir, "workspace.yml"));
                  hasYamlFile = true;
                }
              }

              // If no YAML file, try to fetch runtime configuration (skip for system workspaces)
              if (!hasYamlFile && workspace.id && !isSystemWorkspace) {
                try {
                  const client = getAtlasClient();
                  const workspaceDetails = await client.getWorkspace(workspace.id);

                  if ("config" in workspaceDetails && workspaceDetails.config) {
                    // Save runtime config as YAML
                    const yamlContent = stringify(workspaceDetails.config);
                    const configPath = join(workspaceDir, "runtime-config.yml");
                    await writeFile(configPath, yamlContent, "utf-8");

                    // Also save a note explaining this is runtime config
                    const notePath = join(workspaceDir, "README.txt");
                    await writeFile(
                      notePath,
                      `This workspace configuration was fetched from the runtime.\n` +
                        `Workspace ID: ${workspace.id}\n` +
                        `Name: ${workspace.name}\n` +
                        `Path: ${workspace.path}\n` +
                        `Type: ${isSystemWorkspace ? "System Workspace" : "User Workspace"}\n` +
                        `Status: ${workspaceDetails.status || "unknown"}\n`,
                      "utf-8",
                    );
                  }
                } catch {
                  // Silently skip if daemon is not running or workspace not found
                  continue;
                }
              } else if (isSystemWorkspace && !hasYamlFile) {
                // For system workspaces without YAML files, just note their presence
                const notePath = join(workspaceDir, "README.txt");
                await writeFile(
                  notePath,
                  `System workspace (configuration embedded in Atlas binary)\n` +
                    `Name: ${workspace.name}\n` +
                    `Path: ${workspace.path}\n` +
                    `ID: ${workspace.id || "not set"}\n`,
                  "utf-8",
                );
              } else if (!hasYamlFile && !workspace.id) {
                // No YAML file and no ID to fetch runtime config
                const notePath = join(workspaceDir, "NO_CONFIG.txt");
                await writeFile(
                  notePath,
                  `This workspace has no workspace.yml file and no workspace ID for fetching runtime config.\n` +
                    `Name: ${workspace.name}\n` +
                    `Path: ${workspace.path}\n` +
                    `Type: ${isSystemWorkspace ? "System Workspace" : "User Workspace"}\n`,
                  "utf-8",
                );
              }

              // Also collect workspace runtime logs if available
              const workspaceLogsDir = join(getAtlasLogsDir(), "workspaces", workspace.name);
              if (await exists(workspaceLogsDir)) {
                const workspaceLogsDest = join(workspaceDir, "logs");
                await this.copyDirectory(workspaceLogsDir, workspaceLogsDest);
              }
            } catch (error) {
              log.warn(`Failed to collect workspace ${workspace.name}:`, { error });
            }
          }
        } finally {
          kv.close();
        }
      }
    } catch (error) {
      log.warn("Failed to collect workspaces from KV:", { error });
    }
  }

  private async collectSystemWorkspaces(): Promise<void> {
    try {
      // Create system-workspaces directory
      const systemDir = join(this.tempDir, "system-workspaces");
      await ensureDir(systemDir);

      // Try to dynamically import system workspaces
      try {
        const { SYSTEM_WORKSPACES } = await import("@atlas/system/workspaces");

        for (const [id, config] of Object.entries(SYSTEM_WORKSPACES)) {
          try {
            const workspaceDir = join(systemDir, id);
            await ensureDir(workspaceDir);

            // Save as YAML
            const yamlContent = stringify(config);
            const yamlPath = join(workspaceDir, "system-config.yml");
            await writeFile(yamlPath, yamlContent, "utf-8");

            // Save metadata
            const metaPath = join(workspaceDir, "README.txt");
            await writeFile(
              metaPath,
              `System workspace: ${id}\n` +
                `This is a built-in system workspace embedded in the Atlas binary.\n`,
              "utf-8",
            );
          } catch (error) {
            log.warn(`Failed to save system workspace ${id}:`, { error });
          }
        }
      } catch (_err) {
        // If we can't import system workspaces (e.g., running from source vs compiled),
        // try to read them from the filesystem
        const systemWorkspacesPath = join(Deno.cwd(), "packages/system/workspaces");

        if (await exists(systemWorkspacesPath)) {
          // Copy all YAML files from system workspaces directory
          const systemEntries = await readdir(systemWorkspacesPath, { withFileTypes: true });
          for (const entry of systemEntries) {
            if (entry.isFile() && entry.name.endsWith(".yml")) {
              try {
                const sourcePath = join(systemWorkspacesPath, entry.name);
                const destPath = join(systemDir, entry.name);
                await Deno.copyFile(sourcePath, destPath);
              } catch (error) {
                log.warn(`Failed to copy system workspace ${entry.name}:`, { error });
              }
            }
          }

          // Add a note about system workspaces
          const notePath = join(systemDir, "README.txt");
          await writeFile(
            notePath,
            `System workspaces are built-in workspaces that come with Atlas.\n` +
              `These YAML files define the system workspace configurations.\n`,
            "utf-8",
          );
        }
      }
    } catch (error) {
      log.warn("Failed to collect system workspaces:", { error });
    }
  }

  private async collectOpenFiles(): Promise<void> {
    const outputDir = join(this.tempDir, "system", "open-files");
    await ensureDir(outputDir);

    try {
      // Get the daemon PID from ServiceManager if available
      let daemonPid: number | undefined;
      if (this.options.getServiceStatus) {
        const status = await this.options.getServiceStatus();
        if (status.running && status.pid) {
          daemonPid = status.pid;
        }
      }

      // Collect from daemon if PID available, otherwise from current process
      const report = await collectOpenFiles(daemonPid);

      // Save as JSON
      const jsonPath = join(outputDir, "open-files.json");
      await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");
    } catch (error) {
      // Never let diagnostics crash the main process - fail silently

      // Save error info for debugging
      const errorPath = join(outputDir, "collection-error.txt");
      await writeFile(errorPath, stringifyError(error), "utf-8");
    }
  }

  private async copyDirectory(
    source: string,
    dest: string,
    excludeDirs: string[] = [],
  ): Promise<void> {
    await ensureDir(dest);

    const sourceEntries = await readdir(source, { withFileTypes: true });
    for (const entry of sourceEntries) {
      // Skip excluded directories
      if (entry.isDirectory() && excludeDirs.includes(entry.name)) {
        continue;
      }

      const sourcePath = join(source, entry.name);
      const destPath = join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(sourcePath, destPath, excludeDirs);
      } else {
        try {
          await Deno.copyFile(sourcePath, destPath);
        } catch (error) {
          log.warn(`Failed to copy ${entry.name}:`, { error });
        }
      }
    }
  }

  private async collectSystemInfo(): Promise<Record<string, unknown>> {
    const systemInfo: Record<string, unknown> = {};

    // OS Information
    try {
      systemInfo.os = Deno.build.os;
      systemInfo.arch = Deno.build.arch;
      systemInfo.osVersion = Deno.osRelease();
      systemInfo.hostname = Deno.hostname();
    } catch (error) {
      log.warn("Failed to collect basic OS info:", { error });
    }

    // OS Language
    try {
      systemInfo.osLanguage = await this.getOSLanguage();
    } catch {
      systemInfo.osLanguage = "unknown";
    }

    // Terminal Information
    try {
      const size = Deno.consoleSize();
      systemInfo.terminal = { columns: size.columns, rows: size.rows };
    } catch {
      systemInfo.terminal = { columns: "unknown", rows: "unknown" };
    }

    // Screen Resolution
    try {
      systemInfo.screenResolution = await this.getScreenResolution();
    } catch {
      systemInfo.screenResolution = "unknown";
    }

    // Deno Environment Information
    systemInfo.deno = {
      version: Deno.version.deno,
      v8Version: Deno.version.v8,
      typescriptVersion: Deno.version.typescript,
    };

    // Directory Information
    systemInfo.directories = {
      userHome: env.HOME || env.USERPROFILE || "unknown",
      currentDirectory: Deno.cwd(),
      atlasHome: getAtlasHome(),
    };

    // Environment Information
    systemInfo.environment = {};
    if (Deno.build.os === "windows") {
      systemInfo.environment = {
        tempDirectory: env.TEMP || "unknown",
        systemDrive: env.SYSTEMDRIVE || "unknown",
      };
    } else {
      systemInfo.environment = { shell: env.SHELL || "unknown", tmpdir: env.TMPDIR || "/tmp" };
    }

    // Language environment variables
    const langVars = ["LANG", "LC_ALL", "LC_CTYPE", "LANGUAGE"] as const;
    const languageEnv: Record<string, string> = {};
    for (const varName of langVars) {
      const value = env[varName];
      if (value) {
        languageEnv[varName] = value;
      }
    }
    if (Object.keys(languageEnv).length > 0) {
      systemInfo.languageEnvironment = languageEnv;
    }

    // Memory Information
    try {
      const memInfo = Deno.systemMemoryInfo();
      systemInfo.memory = {
        totalGB: Number((memInfo.total / 1024 / 1024 / 1024).toFixed(2)),
        freeGB: Number((memInfo.free / 1024 / 1024 / 1024).toFixed(2)),
        availableGB: Number((memInfo.available / 1024 / 1024 / 1024).toFixed(2)),
      };
    } catch {
      systemInfo.memory = "unknown";
    }

    // Network and Certificate Information
    try {
      systemInfo.network = await this.getNetworkInfo();
    } catch {
      systemInfo.network = "unknown";
    }

    return systemInfo;
  }

  private async getOSLanguage(): Promise<string> {
    if (Deno.build.os === "darwin") {
      // macOS - use defaults command
      try {
        const command = new Deno.Command("defaults", { args: ["read", "-g", "AppleLocale"] });
        const { stdout } = await command.output();
        const locale = new TextDecoder().decode(stdout).trim();

        // Also get the human-readable language name
        const langCommand = new Deno.Command("defaults", {
          args: ["read", "-g", "AppleLanguages"],
        });
        const { stdout: langOut } = await langCommand.output();
        const languages = new TextDecoder().decode(langOut).trim();

        return `${locale} (Primary languages: ${languages})`;
      } catch {
        return "unknown";
      }
    } else if (Deno.build.os === "linux") {
      // Linux - check locale
      try {
        const command = new Deno.Command("sh", { args: ["-c", "echo $LANG"] });
        const { stdout } = await command.output();
        const currentLocale = new TextDecoder().decode(stdout).trim() || env.LANG || "unknown";

        return currentLocale;
      } catch {
        // Fallback to environment variables
        return env.LANG || env.LC_ALL || "unknown";
      }
    } else if (Deno.build.os === "windows") {
      // Windows - use PowerShell to get culture info
      try {
        const command = new Deno.Command("powershell", {
          args: ["-Command", "Get-Culture | Select-Object Name, DisplayName | ConvertTo-Json"],
          stdin: "null",
          stdout: "piped",
          stderr: "null",
        });
        const { stdout } = await command.output();
        const output = new TextDecoder().decode(stdout);
        const CultureSchema = z.object({ Name: z.string(), DisplayName: z.string() });
        const culture = CultureSchema.parse(JSON.parse(output));

        // Also get UI language
        const uiCommand = new Deno.Command("powershell", {
          args: ["-Command", "[System.Globalization.CultureInfo]::CurrentUICulture.Name"],
          stdin: "null",
          stdout: "piped",
          stderr: "null",
        });
        const { stdout: uiOut } = await uiCommand.output();
        const uiLang = new TextDecoder().decode(uiOut).trim();

        return `${culture.Name} - ${culture.DisplayName} (UI: ${uiLang})`;
      } catch {
        return "unknown";
      }
    }

    return "unknown";
  }

  private async getScreenResolution(): Promise<string> {
    if (Deno.build.os === "darwin") {
      // macOS
      try {
        const command = new Deno.Command("system_profiler", { args: ["SPDisplaysDataType"] });
        const { stdout } = await command.output();
        const output = new TextDecoder().decode(stdout);
        const resolutionMatch = output.match(/Resolution: (\d+ x \d+)/);
        return resolutionMatch?.[1] ? resolutionMatch[1] : "unknown";
      } catch {
        return "unknown";
      }
    } else if (Deno.build.os === "linux") {
      // Linux - try multiple methods
      // Method 1: xrandr (X11)
      try {
        const command = new Deno.Command("xrandr", { args: ["--current"] });
        const { stdout } = await command.output();
        const output = new TextDecoder().decode(stdout);
        const resolutionMatch = output.match(/(\d+x\d+)\s+\d+\.\d+\*/);
        if (resolutionMatch?.[1]) {
          return resolutionMatch[1].replace("x", " x ");
        }
      } catch {
        // xrandr failed, continue to next method
      }

      // Method 2: Check /sys/class/drm for framebuffer info
      try {
        const command = new Deno.Command("cat", { args: ["/sys/class/graphics/fb0/virtual_size"] });
        const { stdout } = await command.output();
        const output = new TextDecoder().decode(stdout).trim();
        if (output.match(/\d+,\d+/)) {
          return output.replace(",", " x ");
        }
      } catch {
        // framebuffer method failed
      }

      return "unknown";
    } else if (Deno.build.os === "windows") {
      // Windows - try wmic first, then PowerShell
      try {
        // Method 1: wmic (works on older Windows)
        const command = new Deno.Command("wmic", {
          args: [
            "path",
            "Win32_VideoController",
            "get",
            "CurrentHorizontalResolution,CurrentVerticalResolution",
          ],
          stdin: "null",
          stdout: "piped",
          stderr: "null",
        });
        const { stdout, success } = await command.output();
        if (success) {
          const output = new TextDecoder().decode(stdout);
          const lines = output.split("\n").filter((line) => line.trim());
          if (lines.length > 1 && lines[1]) {
            const values = lines[1].trim().split(/\s+/);
            if (values.length >= 2 && values[0] !== "" && values[1] !== "") {
              return `${values[0]} x ${values[1]}`;
            }
          }
        }
      } catch {
        // wmic failed, try PowerShell
      }

      // Method 2: PowerShell (for newer Windows)
      try {
        const command = new Deno.Command("powershell", {
          args: [
            "-Command",
            "Get-CimInstance -ClassName Win32_VideoController | Select-Object CurrentHorizontalResolution, CurrentVerticalResolution | Format-List",
          ],
          stdin: "null",
          stdout: "piped",
          stderr: "null",
        });
        const { stdout } = await command.output();
        const output = new TextDecoder().decode(stdout);
        const widthMatch = output.match(/CurrentHorizontalResolution\s*:\s*(\d+)/);
        const heightMatch = output.match(/CurrentVerticalResolution\s*:\s*(\d+)/);
        if (widthMatch && heightMatch) {
          return `${widthMatch[1]} x ${heightMatch[1]}`;
        }
      } catch {
        // PowerShell also failed
      }

      return "unknown";
    }
    return "unknown";
  }

  private async getNetworkInfo(): Promise<Record<string, unknown>> {
    const networkInfo: Record<string, unknown> = {};

    // Proxy environment variables
    const proxyVars = [
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "NO_PROXY",
      "no_proxy",
      "ALL_PROXY",
      "all_proxy",
    ] as const;
    const proxyConfig: Record<string, string> = {};
    for (const varName of proxyVars) {
      const value = env[varName];
      if (value) {
        proxyConfig[varName] = value;
      }
    }
    if (Object.keys(proxyConfig).length > 0) {
      networkInfo.proxyConfiguration = proxyConfig;
    }

    // Certificate environment variables
    const certVars = [
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "DENO_CERT",
      "DENO_TLS_CA_STORE",
    ] as const;
    const certConfig: Record<string, string> = {};
    for (const varName of certVars) {
      const value = env[varName];
      if (value) {
        certConfig[varName] = value;
      }
    }
    if (Object.keys(certConfig).length > 0) {
      networkInfo.certificateConfiguration = certConfig;
    }

    // Test SSL connectivity to critical endpoints
    const endpoints = [
      { name: "Anthropic API", url: "https://api.anthropic.com" },
      { name: "Atlas API", url: "https://atlas.tempestdx.com" },
    ];

    const connectivityTests: Record<string, unknown>[] = [];
    for (const endpoint of endpoints) {
      try {
        const startTime = performance.now();
        const response = await fetch(endpoint.url, {
          method: "HEAD",
          signal: AbortSignal.timeout(5000), // 5 second timeout
        });
        const endTime = performance.now();

        connectivityTests.push({
          endpoint: endpoint.name,
          url: endpoint.url,
          success: true,
          statusCode: response.status,
          responseTime: `${Math.round(endTime - startTime)}ms`,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        connectivityTests.push({
          endpoint: endpoint.name,
          url: endpoint.url,
          success: false,
          error: errorMsg,
          errorType: error instanceof Error ? error.constructor.name : "unknown",
        });
      }
    }
    networkInfo.connectivityTests = connectivityTests;

    // System certificate verification
    try {
      const certVerifications: Record<string, unknown>[] = [];

      // Test certificate verification for each endpoint
      for (const endpoint of endpoints) {
        const verifyResult: Record<string, unknown> = {
          endpoint: endpoint.name,
          url: endpoint.url,
        };

        try {
          if (Deno.build.os === "darwin") {
            // Use openssl to verify certificate chain on macOS
            const command = new Deno.Command("openssl", {
              args: [
                "s_client",
                "-connect",
                `${new URL(endpoint.url).hostname}:443`,
                "-servername",
                new URL(endpoint.url).hostname,
                "-showcerts",
              ],
              stdin: "null",
              stdout: "piped",
              stderr: "piped",
            });
            const { stdout } = await command.output();
            const output = new TextDecoder().decode(stdout);

            // Check for verification result
            if (output.includes("Verify return code: 0 (ok)")) {
              verifyResult.certificateValid = true;
              verifyResult.verifyCode = "0 (ok)";
            } else {
              const verifyMatch = output.match(/Verify return code: (\d+) \(([^)]+)\)/);
              if (verifyMatch) {
                verifyResult.certificateValid = false;
                verifyResult.verifyCode = `${verifyMatch[1]} (${verifyMatch[2]})`;
              }
            }

            // Extract certificate chain info
            const certMatches = output.match(/s:.*\n\s+i:.*/g);
            if (certMatches) {
              verifyResult.certificateChain = certMatches.map((match) => {
                const lines = match.split("\n");
                const subject = lines[0] ? lines[0].substring(2).trim() : "unknown";
                const issuer = lines[1] ? lines[1].substring(4).trim() : "unknown";
                return { subject, issuer };
              });
            }
          } else if (Deno.build.os === "linux") {
            // Similar openssl command for Linux
            const command = new Deno.Command("openssl", {
              args: [
                "s_client",
                "-connect",
                `${new URL(endpoint.url).hostname}:443`,
                "-servername",
                new URL(endpoint.url).hostname,
              ],
              stdin: "null",
              stdout: "piped",
              stderr: "piped",
            });
            const { stdout } = await command.output();
            const output = new TextDecoder().decode(stdout);

            if (output.includes("Verify return code: 0 (ok)")) {
              verifyResult.certificateValid = true;
              verifyResult.verifyCode = "0 (ok)";
            } else {
              const verifyMatch = output.match(/Verify return code: (\d+) \(([^)]+)\)/);
              if (verifyMatch) {
                verifyResult.certificateValid = false;
                verifyResult.verifyCode = `${verifyMatch[1]} (${verifyMatch[2]})`;
              }
            }
          } else if (Deno.build.os === "windows") {
            // Windows doesn't have openssl by default, just note the platform
            verifyResult.platform = "Windows";
            verifyResult.note =
              "Certificate verification requires manual inspection of Windows Certificate Store";
          }
        } catch (error) {
          verifyResult.verificationError = error instanceof Error ? error.message : String(error);
        }

        certVerifications.push(verifyResult);
      }

      if (certVerifications.length > 0) {
        networkInfo.certificateVerification = certVerifications;
      }
    } catch {
      // Ignore certificate verification errors
    }

    // DNS resolver information
    try {
      if (Deno.build.os !== "windows") {
        const resolvConf = await readFile("/etc/resolv.conf", "utf-8").catch(() => null);
        if (resolvConf) {
          const nameservers = resolvConf
            .split("\n")
            .filter((line) => line.trim().startsWith("nameserver"))
            .map((line) => line.split(/\s+/)[1])
            .filter(Boolean);
          if (nameservers.length > 0) {
            networkInfo.dnsServers = nameservers;
          }
        }
      }
    } catch {
      // Ignore DNS info errors
    }

    return networkInfo;
  }

  private async createTarGzArchive(outputPath: string): Promise<void> {
    // Create metadata file
    const metadataPath = join(this.tempDir, "metadata.json");
    const versionInfo = this.options.versionInfo || {
      version: "unknown",
      gitSha: undefined,
      isNightly: false,
      isDev: true,
      isCompiled: false,
    };

    // Collect system information
    const systemInfo = await this.collectSystemInfo();

    // Derive channel from version info
    const channel = versionInfo.isNightly
      ? ReleaseChannel.Nightly
      : versionInfo.isDev
        ? ReleaseChannel.Edge
        : versionInfo.isCompiled
          ? ReleaseChannel.Stable
          : ReleaseChannel.Edge;

    const metadata = {
      timestamp: new Date().toISOString(),
      atlasVersion: versionInfo.version,
      gitSha: versionInfo.gitSha || undefined,
      channel,
      isCompiled: versionInfo.isCompiled,
      isDev: versionInfo.isDev,
      platform: Deno.build.os,
      denoVersion: Deno.version.deno,
      systemInfo: systemInfo,
    };
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

    // Convert directory to tar stream entries
    const tarEntries = await this.createTarStreamEntries(this.tempDir);

    // Create the output file
    const outputFile = await Deno.open(outputPath, { write: true, create: true });
    let fileClosed = false;

    try {
      // Create tar.gz archive using streaming API
      await ReadableStream.from(tarEntries)
        .pipeThrough(new TarStream())
        .pipeThrough(new CompressionStream("gzip"))
        .pipeTo(outputFile.writable);
      // File is automatically closed when pipeTo completes successfully
      fileClosed = true;
    } catch (error) {
      // Only try to close file if it wasn't already closed
      if (!fileClosed) {
        try {
          outputFile.close();
        } catch {
          // Ignore close errors - file might already be closed
        }
      }
      throw error;
    }

    // Clean up temp directory
    await Deno.remove(this.tempDir, { recursive: true });
  }

  private async createTarStreamEntries(baseDir: string): Promise<TarStreamInput[]> {
    const entries: TarStreamInput[] = [];
    const { relative } = await import("@std/path");

    // Walk through all files and directories
    for await (const entry of walk(baseDir)) {
      // Skip the base directory itself
      if (entry.path === baseDir) continue;

      // Get relative path using the standard library
      let relativePath = relative(baseDir, entry.path);

      // Convert to forward slashes for tar format (critical for Windows)
      relativePath = relativePath.replace(/\\/g, "/");

      // Double-check we have a valid relative path
      if (!relativePath) continue;

      // Truncate long paths to fit within tar's 100-byte limit
      // Keep the important parts: directory structure and filename
      if (relativePath.length > 99) {
        const parts = relativePath.split("/");
        const filename = parts[parts.length - 1];

        // Skip truncation if filename is undefined (shouldn't happen with valid paths)
        if (!filename) {
          continue;
        }

        // If just the filename is too long, truncate it
        if (filename.length > 90) {
          const ext = filename.lastIndexOf(".");
          const name = ext > 0 ? filename.substring(0, ext) : filename;
          const extension = ext > 0 ? filename.substring(ext) : "";
          const truncatedName = `${name.substring(0, 85 - extension.length)}~${extension}`;
          parts[parts.length - 1] = truncatedName;
          relativePath = parts.join("/");
        } else {
          // Otherwise, shorten directory names
          const maxDirLength = Math.floor((95 - filename.length) / (parts.length - 1));
          for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (part && part.length > maxDirLength) {
              parts[i] = `${part.substring(0, maxDirLength - 1)}~`;
            }
          }
          relativePath = parts.join("/");
        }
      }

      if (entry.isDirectory) {
        // Add directory entry with forward slash
        entries.push({
          type: "directory",
          path: relativePath.endsWith("/") ? relativePath : `${relativePath}/`,
        });
      } else if (entry.isFile) {
        try {
          const stat = await Deno.stat(entry.path);
          // Read file content immediately instead of opening a stream
          const content = await Deno.readFile(entry.path);

          entries.push({
            type: "file",
            path: relativePath,
            size: stat.size,
            readable: new ReadableStream({
              start(controller) {
                controller.enqueue(content);
                controller.close();
              },
            }),
          });
        } catch (error) {
          log.warn(`Failed to add ${relativePath} to tar:`, { error });
        }
      }
    }

    return entries;
  }
}
