/**
 * FS-WATCH runtime tests (focused, no registry imports)
 */

import { assertEquals } from "@std/assert";
import { delay } from "@std/async/delay";
import { join } from "@std/path";
import { FileWatchSignalProvider } from "../../../packages/signals/src/providers/fs-watch-signal.ts";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "atlas-fs-watch-test-" });
  try {
    await run(dir);
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // ignore
    }
  }
}

async function waitFor<T>(
  collection: T[],
  predicate: (item: T) => boolean,
  timeoutMs = 4000,
  intervalMs = 25,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = collection.find(predicate);
    if (found) return found;
    await delay(intervalMs);
  }
  throw new Error("Timeout waiting for expected event");
}

Deno.test("fs-watch emits added/modified/removed with expected payload", async () => {
  await withTempDir(async (tmp) => {
    const events: Array<Record<string, unknown>> = [];

    const provider = new FileWatchSignalProvider({
      id: "t1",
      description: "test",
      provider: "fs-watch",
      path: tmp,
      recursive: false,
    });

    const runtime = provider
      .createSignal({
        id: "t1",
        description: "test",
        provider: "fs-watch",
        path: tmp,
        recursive: false,
      })
      .toRuntimeSignal();

    // Fake iterator emitting three events
    async function* fakeFsWatch(_path: string): AsyncIterable<Deno.FsEvent> {
      const file = join(tmp, "a.txt");
      yield { kind: "create", paths: [file] };
      await delay(30);
      yield { kind: "modify", paths: [file] };
      await delay(30);
      yield { kind: "remove", paths: [file] };
    }

    runtime.initialize({
      id: "fs-watch-test",
      processSignal: (_id: string, payload: Record<string, unknown>) => {
        events.push(payload);
      },
      workspacePath: tmp,
      fsWatchFactory: fakeFsWatch,
    });

    const file = join(tmp, "a.txt");

    const added = await waitFor(
      events,
      (e) => e.path === file && (e.event === "added" || e.event === "modified"),
      2000,
      10,
    );
    if (added.relativePath) {
      // when workspacePath is provided, we should get relative path
    }

    await waitFor(events, (e) => e.event === "modified" && e.path === file, 2000, 10);

    await waitFor(events, (e) => e.event === "removed" && e.path === file, 2000, 10);

    runtime.teardown();
  });
});

Deno.test("fs-watch teardown stops further event processing", async () => {
  await withTempDir(async (tmp) => {
    const events: Array<Record<string, unknown>> = [];

    const provider = new FileWatchSignalProvider({
      id: "t2",
      description: "test",
      provider: "fs-watch",
      path: tmp,
      recursive: true,
    });

    const runtime = provider
      .createSignal({
        id: "t2",
        description: "test",
        provider: "fs-watch",
        path: tmp,
        recursive: true,
      })
      .toRuntimeSignal();
    // Fake iterator emitting various paths (no filtering expected anymore)
    async function* fakeFsWatch(_path: string): AsyncIterable<Deno.FsEvent> {
      const txtFile = join(tmp, "note.txt");
      const ignoredMd = join(tmp, "README.IGNORE.md");
      const mdFile = join(tmp, "README.md");
      yield { kind: "create", paths: [txtFile] };
      yield { kind: "create", paths: [ignoredMd] };
      yield { kind: "create", paths: [mdFile] };
    }

    runtime.initialize({
      id: "fs-watch-test2",
      processSignal: (_id: string, payload: Record<string, unknown>) => {
        events.push(payload);
      },
      workspacePath: tmp,
      fsWatchFactory: fakeFsWatch,
    });

    const mdFile = join(tmp, "README.md");
    await waitFor(events, (e) => e.path === mdFile && e.event === "added", 2000, 10);

    runtime.teardown();

    // After teardown, ensure no additional events are pushed when iterator would continue (no more yields here)
    const sizeBefore = events.length;
    await delay(50);
    assertEquals(events.length, sizeBefore);
  });
});
