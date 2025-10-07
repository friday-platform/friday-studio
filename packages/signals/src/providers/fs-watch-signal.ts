/**
 * File Watch Signal Provider - Stub implementation
 * Watches filesystem paths for changes and emits events
 *
 * NOTE: This is a skeleton for initial wiring. Behavior will be implemented next.
 */

import {
  computeRelativeToRoot,
  createFsWatchRunner,
  isDirectoryPath,
  mapFsEventKind,
  resolveToAbsolutePath,
} from "@atlas/fs-watch";
import { isAbsolute, normalize, resolve } from "@std/path";
import type {
  HealthStatus,
  IProvider,
  IProviderSignal,
  ISignalProvider,
  ProviderState,
} from "./types.ts";
import { ProviderStatus, ProviderType } from "./types.ts";

export interface FileWatchSignalConfig extends Record<string, unknown> {
  id: string;
  description: string;
  provider: "fs-watch";
  path: string;
  recursive?: boolean;
}

export class FileWatchSignalProvider implements ISignalProvider, IProvider {
  readonly id: string;
  readonly type = ProviderType.SIGNAL;
  readonly name = "File Watch Signal Provider";
  readonly version = "0.1.0";

  private config: FileWatchSignalConfig;
  private state: ProviderState = { status: ProviderStatus.NOT_CONFIGURED };

  constructor(config: FileWatchSignalConfig) {
    this.validateConfig(config);
    this.config = config;
    this.id = config.id;
  }

  private validateConfig(config: FileWatchSignalConfig): void {
    if (!config.path || typeof config.path !== "string") {
      throw new Error("fs-watch signal requires a valid 'path' string");
    }
  }

  // Lifecycle
  setup(): void {
    this.state.status = ProviderStatus.READY;
    this.state.config = this.config;
  }

  teardown(): void {
    this.state.status = ProviderStatus.DISABLED;
  }

  getState(): ProviderState {
    return { ...this.state, lastHealthCheck: new Date() };
  }

  checkHealth(): Promise<HealthStatus> {
    return Promise.resolve({
      healthy: this.state.status === ProviderStatus.READY,
      lastCheck: new Date(),
    });
  }

  createSignal(config: FileWatchSignalConfig): IProviderSignal {
    return new FileWatchProviderSignal(this.id, config);
  }
}

class FileWatchProviderSignal implements IProviderSignal {
  readonly id: string;
  readonly providerId: string;
  readonly config: FileWatchSignalConfig;

  constructor(providerId: string, config: FileWatchSignalConfig) {
    this.id = config.id;
    this.providerId = providerId;
    this.config = config;
  }

  validate(): boolean {
    return !!this.config.path;
  }

  toRuntimeSignal(): FileWatchRuntimeSignal {
    return new FileWatchRuntimeSignal(this.providerId, this.config);
  }
}

interface InitializeContext {
  id: string;
  processSignal: (signalId: string, payload: Record<string, unknown>) => Promise<void> | void;
  workspacePath?: string;
  fsWatchFactory?: (path: string, options: { recursive: boolean }) => AsyncIterable<Deno.FsEvent>;
}

class FileWatchRuntimeSignal {
  private readonly config: FileWatchSignalConfig;
  private stopRunner: (() => void) | null = null;
  private stopped = false;
  private signalId: string = "";
  private processSignal:
    | ((signalId: string, payload: Record<string, unknown>) => Promise<void> | void)
    | null = null;
  private absoluteWatchPath: string = "";
  private workspaceRoot: string | undefined;

  constructor(_providerId: string, config: FileWatchSignalConfig) {
    // provider id currently unused in runtime signal
    this.config = config;
  }

  initialize(context: InitializeContext): void {
    this.signalId = context.id;
    this.processSignal = context.processSignal;
    this.workspaceRoot = context.workspacePath;

    // Resolve absolute watch path
    this.absoluteWatchPath = resolveToAbsolutePath(this.config.path, {
      basePath: this.workspaceRoot || Deno.cwd(),
    });

    // Create watcher (allow factory override for testing)
    const recursive = this.config.recursive !== false;

    // Create debounced handler (internal default, not exposed in workspace config)
    // Use a very low debounce when a test watch factory is injected; otherwise a safer production default
    const debounceMs = context.fsWatchFactory ? 10 : 500;

    const handler = async (event: Deno.FsEvent) => {
      if (this.stopped || !this.processSignal) return;

      const kind = event.kind;
      const mappedEvent = mapFsEventKind(kind);
      if (!mappedEvent) return;

      for (const p of event.paths) {
        const pathAbs = isAbsolute(p)
          ? normalize(p)
          : normalize(resolve(this.absoluteWatchPath, p));

        const isDirectory = await isDirectoryPath(pathAbs);

        const rel = computeRelativeToRoot(pathAbs, this.workspaceRoot);
        const payload: Record<string, unknown> = {
          path: pathAbs,
          relativePath: rel,
          event: mappedEvent,
          isDirectory,
          timestamp: new Date().toISOString(),
        };

        await Promise.resolve(this.processSignal(this.signalId, payload));
      }
    };

    // Create runner using shared helper (supports debouncing and filtering)
    // We track these filesystem events:
    // - "create": New files/directories added to watched path
    // - "modify": Existing files changed (content or metadata)
    // - "rename": Files/directories renamed or moved within same volume
    // - "remove": Files/directories deleted from watched path
    // Note: "rename" includes both filename changes and moves between folders
    // on the same disk, as both use the same rename() system call on Unix/macOS
    const runner = createFsWatchRunner({
      watchPath: this.absoluteWatchPath,
      recursive,
      debounceMs,
      filterKind: (k) => k === "create" || k === "modify" || k === "rename" || k === "remove",
      onEvent: handler,
      watchFactory: context.fsWatchFactory,
    });
    this.stopRunner = () => runner.stop();
  }

  teardown(): void {
    this.stopped = true;
    if (this.stopRunner) {
      try {
        this.stopRunner();
      } catch {
        // ignore
      }
      this.stopRunner = null;
    }
    this.processSignal = null;
  }
}
