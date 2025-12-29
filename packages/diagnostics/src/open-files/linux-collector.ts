import { readdir, readlink } from "node:fs/promises";
import { isErrnoException } from "@atlas/utils";
import type { FileType, OpenFileEntry, PlatformCollector } from "./types.ts";

function detectType(path: string): FileType {
  if (path.startsWith("socket:")) return "SOCK";
  if (path.startsWith("pipe:")) return "PIPE";
  if (path.startsWith("/dev/")) return "CHR";
  if (path === "anon_inode:[eventfd]") return "UNKNOWN";
  return "REG";
}

export const LinuxCollector: PlatformCollector = {
  async *getOpenFiles(pid: number, signal: AbortSignal): AsyncIterableIterator<OpenFileEntry> {
    const fdDir = `/proc/${pid}/fd`;

    const fdEntries = await readdir(fdDir, { withFileTypes: true });
    for (const entry of fdEntries) {
      if (signal.aborted) {
        return;
      }

      const fd = entry.name;

      try {
        const link = await readlink(`${fdDir}/${fd}`, "utf-8");

        yield { fd, type: detectType(link), path: link };
      } catch (error) {
        if (isErrnoException(error) && (error.code === "EACCES" || error.code === "EPERM")) {
          yield { fd, type: "UNKNOWN", path: "[Permission Denied]" };
        }
      }
    }
  },
};
