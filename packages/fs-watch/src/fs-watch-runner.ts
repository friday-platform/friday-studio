import { debounce } from "@std/async";

export type FsWatchRunner = { stop: () => void };

export interface FsWatchRunnerOptions {
  watchPath: string;
  recursive: boolean;
  debounceMs: number;
  onEvent: (event: Deno.FsEvent) => void;
  filterKind?: (kind: Deno.FsEvent["kind"]) => boolean;
  watchFactory?: (path: string, options: { recursive: boolean }) => AsyncIterable<Deno.FsEvent>;
}

export function createFsWatchRunner(options: FsWatchRunnerOptions): FsWatchRunner {
  const { watchPath, recursive, debounceMs, onEvent, filterKind, watchFactory } = options;
  const shouldHandleKind =
    filterKind ?? ((k: Deno.FsEvent["kind"]) => k === "create" || k === "modify" || k === "remove");
  const debouncedHandler = debounce(onEvent, debounceMs);
  let stopped = false;

  if (watchFactory) {
    // Use injected iterator (testing or custom source)
    const iterator = watchFactory(watchPath, { recursive });
    (async () => {
      try {
        for await (const event of iterator) {
          if (stopped) break;
          if (shouldHandleKind(event.kind)) {
            debouncedHandler(event);
          }
        }
      } catch {
        // iterator finished or errored; stop gracefully
      }
    })();

    return {
      stop() {
        stopped = true;
      },
    };
  }

  const watcher = Deno.watchFs(watchPath, { recursive });

  (async () => {
    try {
      for await (const event of watcher) {
        if (stopped) break;
        if (shouldHandleKind(event.kind)) {
          debouncedHandler(event);
        }
      }
    } catch {
      // watcher closed or errored; stop gracefully
    }
  })();

  return {
    stop() {
      try {
        watcher.close();
      } catch {
        // ignore
      }
      stopped = true;
    },
  };
}
