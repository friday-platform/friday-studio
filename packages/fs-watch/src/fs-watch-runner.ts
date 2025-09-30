import { logger } from "@atlas/logger";
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
          logger.debug("fs watch event received via watchFactory", { event });
          if (shouldHandleKind(event.kind)) {
            logger.debug("handling fs watch event via watchFactory", { event });
            debouncedHandler(event);
          }
        }
      } catch (error) {
        logger.error("fs watch error via watchFactory", { error });
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
        logger.debug("fs watch event received via Deno.watchFs", { event });

        // WORKAROUND NOTE: includes check is only for 'removed' actions.
        // There is a bug (https://github.com/denoland/deno/issues/30878) in Deno.watchFs
        // that trigger all registered watchers when a file is removed.
        // This check ensures we only handle events for affected paths.
        if (shouldHandleKind(event.kind) && event.paths.some((p) => p.includes(watchPath))) {
          logger.debug("handling fs watch event via Deno.watchFs", { event });
          debouncedHandler(event);
        }
      }
    } catch (error) {
      logger.error("fs watch error via Deno.watchFs", { error });
      // watcher closed or errored; stop gracefully
    }
  })();

  return {
    stop() {
      try {
        watcher.close();
      } catch (error) {
        logger.error("error closing fs watcher", { error });
        // ignore
      }
      stopped = true;
    },
  };
}
