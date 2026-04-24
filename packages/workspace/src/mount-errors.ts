export class MountSourceNotFoundError extends Error {
  readonly code = "MOUNT_SOURCE_NOT_FOUND" as const;

  constructor(source: string, detail?: string) {
    super(
      detail ??
        `Mount source store '${source}' could not be resolved. ` +
          `Ensure the store exists and the memory adapter is configured correctly.`,
    );
    this.name = "MountSourceNotFoundError";
  }
}

export class MountReadonlyError extends Error {
  readonly code = "MOUNT_READONLY" as const;

  constructor(name: string) {
    super(`Mount '${name}' is read-only (mode='ro'). append() is not permitted.`);
    this.name = "MountReadonlyError";
  }
}

export class MountScopeError extends Error {
  readonly code = "MOUNT_SCOPE_ERROR" as const;

  constructor(scope: string, scopeTarget?: string) {
    super(`Mount scope '${scope}' requires a scopeTarget, got: ${scopeTarget ?? "(none)"}`);
    this.name = "MountScopeError";
  }
}
