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

    for await (const entry of Deno.readDir(fdDir)) {
      if (signal.aborted) {
        return;
      }

      const fd = entry.name;

      try {
        const link = await Deno.readLink(`${fdDir}/${fd}`);

        yield { fd, type: detectType(link), path: link };
      } catch (error) {
        if (error instanceof Deno.errors.PermissionDenied) {
          yield { fd, type: "UNKNOWN", path: "[Permission Denied]" };
        }
      }
    }
  },
};
