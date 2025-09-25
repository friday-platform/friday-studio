import type { FileType, OpenFileEntry, PlatformCollector } from "./types.ts";

function mapLsofType(lsofType?: string): FileType {
  switch (lsofType) {
    case "REG":
    case "VREG":
      return "REG";
    case "DIR":
    case "VDIR":
      return "DIR";
    case "CHR":
    case "VCHR":
      return "CHR";
    case "BLK":
    case "VBLK":
      return "BLK";
    case "FIFO":
    case "PIPE":
      return "PIPE";
    case "IPv4":
    case "IPv6":
    case "sock":
    case "unix":
      return "SOCK";
    default:
      return "UNKNOWN";
  }
}

export const MacOSCollector: PlatformCollector = {
  async *getOpenFiles(pid: number, signal: AbortSignal): AsyncIterableIterator<OpenFileEntry> {
    const command = new Deno.Command("lsof", {
      args: ["-n", "-P", "-p", pid.toString(), "-F", "fnt"],
      signal,
      stdout: "piped",
      stderr: "null",
    });

    const process = command.spawn();
    const reader = process.stdout.getReader();

    try {
      const decoder = new TextDecoder();
      let buffer = "";
      let currentFd: string | undefined;
      let currentPath: string | undefined;
      let currentType: string | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line) continue;

          const field = line[0];
          const value = line.substring(1);

          switch (field) {
            case "f":
              if (currentFd) {
                yield { fd: currentFd, type: mapLsofType(currentType), path: currentPath };
              }
              currentFd = value;
              currentPath = undefined;
              currentType = undefined;
              break;
            case "n":
              currentPath = value;
              break;
            case "t":
              currentType = value;
              break;
          }
        }
      }

      // Yield last entry if exists
      if (currentFd) {
        yield { fd: currentFd, type: mapLsofType(currentType), path: currentPath };
      }
    } finally {
      reader.releaseLock();
      try {
        process.kill();
      } catch {
        /* Process might already be dead */
      }
      await process.status;
    }
  },
};
