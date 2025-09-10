/**
 * Integration test: fs-watch signal end-to-end (provider + runtime signal)
 * Uses injected watcher iterator for determinism.
 */

import { assertEquals } from "@std/assert";
import { delay } from "@std/async/delay";
import { join } from "@std/path";
import { FileWatchSignalProvider } from "../packages/signals/src/providers/fs-watch-signal.ts";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "atlas-fs-watch-int-" });
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

Deno.test("fs-watch integration: emits events with relativePath under workspace root", async () => {
  await withTempDir(async (tmp) => {
    const captured: Array<Record<string, unknown>> = [];

    const provider = new FileWatchSignalProvider({
      id: "int-1",
      description: "integration test",
      provider: "fs-watch",
      path: "content/", // relative to workspace
      recursive: true,
    });

    const runtime = provider
      .createSignal({
        id: "int-1",
        description: "integration test",
        provider: "fs-watch",
        path: "content/",
        recursive: true,
      })
      .toRuntimeSignal() as {
      initialize: (ctx: {
        id: string;
        processSignal: (id: string, payload: Record<string, unknown>) => void;
        workspacePath?: string;
        fsWatchFactory?: (
          path: string,
          options: { recursive: boolean },
        ) => AsyncIterable<Deno.FsEvent>;
      }) => void;
      teardown: () => void;
    };

    // Create a content directory inside workspace root
    const contentDir = join(tmp, "content");
    await Deno.mkdir(contentDir, { recursive: true });
    const file = join(contentDir, "doc.md");

    // Fake iterator emitting events inside workspace
    async function* fakeFsWatch(_path: string): AsyncIterable<Deno.FsEvent> {
      yield { kind: "create", paths: [file] } as Deno.FsEvent;
      await delay(5);
      yield { kind: "modify", paths: [file] } as Deno.FsEvent;
      await delay(5);
      yield { kind: "remove", paths: [file] } as Deno.FsEvent;
    }

    runtime.initialize({
      id: "fs-watch-int",
      processSignal: (_id, payload) => captured.push(payload),
      workspacePath: tmp,
      fsWatchFactory: fakeFsWatch,
    });

    // Allow debounce to flush
    await delay(50);

    // We expect at least one event; verify relativePath and fields
    assertEquals(captured.length > 0, true);
    const first = captured[0] as {
      path: string;
      relativePath?: string;
      event: string;
      isDirectory: boolean;
    };
    assertEquals(typeof first.path, "string");
    assertEquals(first.relativePath, "content/doc.md");
    assertEquals(["added", "modified", "removed"].includes(first.event), true);
    assertEquals(typeof first.isDirectory, "boolean");

    runtime.teardown();
  });
});

Deno.test("fs-watch integration: emits events for all paths (no filters)", async () => {
  await withTempDir(async (tmp) => {
    const captured: Array<Record<string, unknown>> = [];

    const provider = new FileWatchSignalProvider({
      id: "int-2",
      description: "integration test",
      provider: "fs-watch",
      path: tmp,
      recursive: false,
    });

    const runtime = provider
      .createSignal({
        id: "int-2",
        description: "integration test",
        provider: "fs-watch",
        path: tmp,
        recursive: false,
      })
      .toRuntimeSignal() as {
      initialize: (ctx: {
        id: string;
        processSignal: (id: string, payload: Record<string, unknown>) => void;
        workspacePath?: string;
        fsWatchFactory?: (
          path: string,
          options: { recursive: boolean },
        ) => AsyncIterable<Deno.FsEvent>;
      }) => void;
      teardown: () => void;
    };

    const included = join(tmp, "notes.md");
    const excluded = join(tmp, "README.IGNORE.md");

    async function* fakeFsWatch(_path: string): AsyncIterable<Deno.FsEvent> {
      yield { kind: "create", paths: [excluded] } as Deno.FsEvent;
      await delay(20);
      yield { kind: "create", paths: [included] } as Deno.FsEvent;
    }

    runtime.initialize({
      id: "fs-watch-int2",
      processSignal: (_id, payload) => captured.push(payload),
      workspacePath: tmp,
      fsWatchFactory: fakeFsWatch,
    });

    await delay(40);

    // No path-based filtering: both events should be captured
    assertEquals(captured.length, 2);
    const paths = captured.map((e) => (e as { path: string }).path).sort();
    assertEquals(paths.includes(included), true);
    assertEquals(paths.includes(excluded), true);

    runtime.teardown();
  });
});
