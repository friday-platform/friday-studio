# Atlas /send-diagnostics Command Implementation Plan

## Implementation Status: COMPLETED ✅

## Overview

This document outlines the implementation plan for adding a `/send-diagnostics` command to the Atlas
client. The command will collect diagnostic information from the Atlas installation and send it to
the Tempest diagnostic endpoint.

## Architecture Overview

### Data Collection Flow

1. User types `/send-diagnostics` in the Atlas interactive CLI
2. Command collects diagnostic data:
   - All logs from `getAtlasHome()/logs`
   - Memory data from `getAtlasHome()/memory`
   - Storage database files (`storage.db`, `storage.db-shm`, `storage.db-wal`)
   - All workspace configurations from DenoKV
3. Creates a gzip archive with structured directory layout
4. Sends gzip to the diagnostic endpoint using ATLAS_KEY authentication
5. Provides user feedback on success/failure

### Authentication

- Uses the same authentication mechanism as credential fetching
- Requires `ATLAS_KEY` environment variable
- Sends JWT token in Authorization header: `Bearer <token>`

## Implementation Steps

### 1. Add Command Registration

#### File: `src/cli/modules/conversation/commands.tsx`

Add new command registration in the commands array:

```typescript
{
  name: "send-diagnostics",
  description: "Send diagnostic information to Tempest support",
  category: "support",
  aliases: ["diagnostics"],
  handler: SendDiagnosticsCommand,
}
```

### 2. Create Send Diagnostics Command Component

#### File: `src/cli/modules/conversation/SendDiagnosticsCommand.tsx`

Create new React component for the command:

```typescript
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { DiagnosticsCollector } from "../../../utils/diagnostics-collector.ts";
import { AtlasClient } from "@atlas/client";

export const SendDiagnosticsCommand: React.FC<{ args: string[] }> = ({ args }) => {
  const [status, setStatus] = useState<"collecting" | "uploading" | "done" | "error">("collecting");
  const [message, setMessage] = useState("Collecting diagnostic information...");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sendDiagnostics = async () => {
      try {
        // Collect diagnostics
        const collector = new DiagnosticsCollector();
        const gzipPath = await collector.collectAndArchive();

        // Check size
        const fileInfo = await Deno.stat(gzipPath);
        if (fileInfo.size > 100 * 1024 * 1024) { // 100MB
          throw new Error("Diagnostic archive too large (>100MB). Please contact support.");
        }

        setStatus("uploading");
        setMessage("Sending diagnostics to Atlas developers...");

        // Upload via client
        const client = new AtlasClient();
        await client.sendDiagnostics(gzipPath);

        // Clean up temp file
        await Deno.remove(gzipPath).catch(() => {}); // Ignore cleanup errors

        setStatus("done");
        setMessage("Diagnostics sent successfully!");
      } catch (err) {
        setStatus("error");
        setError(err.message);

        // Try to clean up on error too
        if (gzipPath) {
          await Deno.remove(gzipPath).catch(() => {});
        }
      }
    };

    sendDiagnostics();
  }, []);

  if (status === "error") {
    return (
      <Box flexDirection="column">
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={status === "done" ? "green" : "yellow"}>
        {message}
      </Text>
    </Box>
  );
};
```

### 3. Create Diagnostics Collector Utility

#### File: `src/utils/diagnostics-collector.ts`

```typescript
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { getAtlasHome, getAtlasLogsDir } from "./paths.ts";
import { DenoKVStorage } from "../core/storage/deno-kv-storage.ts";
import { tar } from "@std/archive";
import { compress } from "@std/compress";

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
    const gzipPath = join(Deno.makeTempDirSync(), "diagnostics.tar.gz");
    await this.createGzipArchive(gzipPath);

    return gzipPath;
  }

  private async collectLogs(): Promise<void> {
    const logsDir = getAtlasLogsDir();
    try {
      await this.copyDirectory(logsDir, join(this.tempDir, "logs"));
    } catch (err) {
      console.warn("Failed to collect logs:", err.message);
    }
  }

  private async collectMemory(): Promise<void> {
    const memoryDir = join(getAtlasHome(), "memory");
    try {
      await this.copyDirectory(memoryDir, join(this.tempDir, "memory"));
    } catch (err) {
      console.warn("Failed to collect memory:", err.message);
    }
  }

  private async collectStorage(): Promise<void> {
    const storageFiles = ["storage.db", "storage.db-shm", "storage.db-wal"];
    for (const file of storageFiles) {
      const sourcePath = join(getAtlasHome(), file);
      const destPath = join(this.tempDir, "storage", file);
      try {
        await Deno.copyFile(sourcePath, destPath);
      } catch (err) {
        console.warn(`Failed to collect ${file}:`, err.message);
      }
    }
  }

  private async collectWorkspaces(): Promise<void> {
    // Open KV storage to get workspace paths
    const kvPath = join(getAtlasHome(), "storage.db");
    const kv = await Deno.openKv(kvPath);

    try {
      // List all workspaces from KV
      const workspaces = kv.list({ prefix: ["workspaces"] });

      for await (const entry of workspaces) {
        if (entry.value && typeof entry.value === "object" && "path" in entry.value) {
          const workspace = entry.value as { name: string; path: string };
          const workspaceYmlPath = join(workspace.path, "workspace.yml");

          try {
            // Create workspace subdirectory
            const workspaceDir = join(this.tempDir, "workspaces", workspace.name);
            await ensureDir(workspaceDir);

            // Copy workspace.yml
            await Deno.copyFile(workspaceYmlPath, join(workspaceDir, "workspace.yml"));

            // Also collect workspace runtime logs if available
            const workspaceLogsDir = join(getAtlasLogsDir(), "workspaces", workspace.name);
            if (await this.exists(workspaceLogsDir)) {
              await this.copyDirectory(workspaceLogsDir, join(workspaceDir, "logs"));
            }
          } catch (err) {
            console.warn(`Failed to collect workspace ${workspace.name}:`, err.message);
          }
        }
      }
    } finally {
      kv.close();
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
        await Deno.copyFile(sourcePath, destPath);
      }
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await Deno.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async createGzipArchive(outputPath: string): Promise<void> {
    // Create tar archive first
    const tarPath = outputPath.replace(".gz", "");
    const tarFile = await Deno.open(tarPath, { write: true, create: true });

    // Add all files to tar
    const writer = tarFile.writable.getWriter();
    await tar.create(writer, this.tempDir);
    writer.releaseLock();
    tarFile.close();

    // Compress with gzip
    const tarData = await Deno.readFile(tarPath);
    const compressed = compress(tarData, "gzip");
    await Deno.writeFile(outputPath, compressed);

    // Clean up tar file
    await Deno.remove(tarPath);

    // Clean up temp directory
    await Deno.remove(this.tempDir, { recursive: true });
  }
}
```

### 4. Extend Atlas Client

#### File: `packages/client/src/client.ts`

Add new method to AtlasClient class:

```typescript
/**
 * Send diagnostic information to Atlas developers
 */
async sendDiagnostics(gzipPath: string): Promise<void> {
  // Load .env from Atlas home directory first
  const globalAtlasEnv = join(getAtlasHome(), ".env");
  if (await exists(globalAtlasEnv)) {
    await load({ export: true, envPath: globalAtlasEnv, override: false });
  }
  
  // Get ATLAS_KEY from environment (either from .env or env variable)
  const atlasKey = Deno.env.get("ATLAS_KEY");
  if (!atlasKey) {
    throw new Error("ATLAS_KEY not found. Please set it in ~/.atlas/.env or as an environment variable.");
  }
  
  // Validate JWT token
  const validation = CredentialFetcher.validateJWT(atlasKey);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // Read the gzip file
  const diagnosticData = await Deno.readFile(gzipPath);
  
  // Get filename from path
  const filename = gzipPath.split("/").pop() || "diagnostics.tar.gz";
  
  // Get API URL (uses ATLAS_URL env var if set, otherwise uses default)
  // Note: ATLAS_URL supports both http (local testing) and https (production)
  const apiUrl = Deno.env.get("ATLAS_URL") || "https://atlas.tempestdx.com";
  
  // Send to diagnostic endpoint
  const response = await fetch(`${apiUrl}/api/diagnostics/${filename}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${atlasKey}`,
      "Content-Type": "application/gzip",
    },
    body: diagnosticData,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || "Failed to upload diagnostics");
  }
}
```

Also add the following imports at the top of the file:

```typescript
import { join } from "@std/path";
import { exists } from "@std/fs";
import { load } from "@std/dotenv";
import { getAtlasHome } from "../../utils/paths.ts";
import { CredentialFetcher } from "@atlas/core";
```

### 5. Update Command Registry

#### File: `src/cli/modules/conversation/registry.ts`

Import and add the new command:

```typescript
import { SendDiagnosticsCommand } from "./SendDiagnosticsCommand.tsx";

// Add to imports at the top of getCommandRegistry function
```

### 6. Add Required Dependencies

#### File: `deno.json`

Ensure these dependencies are available:

```json
{
  "imports": {
    "@std/archive": "jsr:@std/archive@^0.220.0",
    "@std/compress": "jsr:@std/compress@^0.220.0"
  }
}
```

## Directory Structure in Gzip

The diagnostic archive will have the following structure:

```
diagnostics/
├── logs/
│   ├── atlas.log
│   ├── workspaces/
│   │   └── [workspace-logs]
│   └── [other-log-files]
├── memory/
│   └── [memory-files]
├── storage/
│   ├── storage.db
│   ├── storage.db-shm
│   └── storage.db-wal
└── workspaces/
    ├── workspace-name-1/
    │   ├── workspace.yml
    │   └── logs/
    │       └── [runtime-logs]
    ├── workspace-name-2/
    │   └── workspace.yml
    └── [other-workspaces]
```

## Error Handling

1. **Missing files**: Continue collection, log warnings
2. **Large archive (>100MB)**: Abort upload with clear error message
3. **Missing ATLAS_KEY**: Clear error message directing to ~/.atlas/.env or environment variable
4. **Network errors**: Retry logic with exponential backoff
5. **Server errors**: Display server error message to user

## User Experience

### Success Flow:

```
> /send-diagnostics
Collecting diagnostic information...
Sending diagnostics to Atlas developers...
Diagnostics sent successfully!
```

### Error Flow:

```
> /send-diagnostics
Collecting diagnostic information...
Error: Diagnostic archive too large (>100MB). Please contact support.
```

## Testing Strategy

1. **Unit Tests**:
   - Test DiagnosticsCollector with mock file system
   - Test archive creation and compression
   - Test error handling for missing files

2. **Integration Tests**:
   - Test full flow with mock Atlas daemon
   - Test authentication flow
   - Test large file handling

3. **Manual Testing**:
   - Test with various Atlas configurations
   - Test with missing directories/files
   - Test network error scenarios
   - Test local development with `ATLAS_URL=http://localhost:8020`
   - Test production with default HTTPS endpoint

## Security Considerations

1. **No filtering**: As requested, no sensitive data filtering
2. **Authentication**: Uses existing ATLAS_KEY mechanism
3. **Transport security**:
   - Production: HTTPS required (https://atlas.tempestdx.com)
   - Local testing: HTTP allowed (http://localhost:8020)
   - Controlled by ATLAS_URL environment variable
4. **No local storage**: Temp files cleaned up after upload

## Implementation Timeline

1. **Phase 1**: Core implementation
   - DiagnosticsCollector utility
   - Atlas client extension
   - Basic command implementation

2. **Phase 2**: Polish and testing
   - Error handling improvements
   - Progress feedback
   - Comprehensive testing

3. **Phase 3**: Documentation
   - Update CLI documentation
   - Add usage examples
   - Update help text

## Future Enhancements

1. **Selective collection**: Allow users to exclude certain data types
2. **Upload resume**: Handle interrupted uploads
3. **Local save option**: For offline debugging (if requirements change)

## Implementation Notes

### Completed Implementation Details

1. **Command Registration**: Added to `src/cli/modules/conversation/registry.ts` with handler in
   `commands.tsx`
2. **SendDiagnosticsCommand Component**: Created React component with proper error handling and
   progress feedback
3. **DiagnosticsCollector Utility**: Implemented with native CompressionStream API for gzip
   compression
4. **Atlas Client Extension**: Added `sendDiagnostics` method with proper ATLAS_KEY handling
5. **No External Dependencies**: Used native Deno APIs (CompressionStream) instead of external
   compression libraries

### Key Design Decisions

1. **Gzip Only**: Simplified to use just gzip compression without tar, creating a single compressed
   JSON file
2. **Native APIs**: Used Deno's built-in CompressionStream API instead of external dependencies
3. **Error Handling**: Graceful handling of missing files and directories with console warnings
4. **Authentication**: Follows existing pattern of loading from `~/.atlas/.env` first, then
   environment variables
