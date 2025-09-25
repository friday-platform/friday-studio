import { stringifyError } from "@atlas/utils";
import { LinuxCollector } from "./linux-collector.ts";
import { MacOSCollector } from "./macos-collector.ts";
import type { OpenFileEntry, OpenFilesReport, PlatformCollector } from "./types.ts";

const MAX_COLLECTION_TIME_MS = 5000;

export async function collectOpenFiles(pid?: number): Promise<OpenFilesReport> {
  const targetPid = pid || Deno.pid;
  const collector = getPlatformCollector();

  const startTime = Date.now();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), MAX_COLLECTION_TIME_MS);

  const entries: OpenFileEntry[] = [];
  const byType: Record<string, number> = {};

  try {
    for await (const entry of collector.getOpenFiles(targetPid, controller.signal)) {
      entries.push(entry);
      byType[entry.type] = (byType[entry.type] || 0) + 1;
    }
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") {
      return {
        pid: targetPid,
        files: [],
        byType: {},
        timeMs: Date.now() - startTime,
        error: stringifyError(error),
      };
    }
  }

  return { pid: targetPid, files: entries, byType, timeMs: Date.now() - startTime };
}

function getPlatformCollector(): PlatformCollector {
  switch (Deno.build.os) {
    case "darwin":
      return MacOSCollector;
    case "linux":
      return LinuxCollector;
    case "windows":
      return { async *getOpenFiles() {} };
    default:
      throw new Error(`Unsupported platform: ${Deno.build.os}`);
  }
}
