import { describe, expect, it } from "vitest";
import { MountReadonlyError, MountScopeError, MountSourceNotFoundError } from "../mount-errors.ts";

describe("MountSourceNotFoundError", () => {
  it("carries code MOUNT_SOURCE_NOT_FOUND", () => {
    const err = new MountSourceNotFoundError("ws-1/narrative/logs");
    expect(err.code).toBe("MOUNT_SOURCE_NOT_FOUND");
  });

  it("has a human-readable default message", () => {
    const err = new MountSourceNotFoundError("ws-1/narrative/logs");
    expect(err.message).toContain("ws-1/narrative/logs");
    expect(err.message).toContain("could not be resolved");
  });

  it("accepts a custom detail message", () => {
    const err = new MountSourceNotFoundError("src", "custom detail");
    expect(err.message).toBe("custom detail");
  });

  it("has name MountSourceNotFoundError", () => {
    const err = new MountSourceNotFoundError("x");
    expect(err.name).toBe("MountSourceNotFoundError");
  });

  it("is an instance of Error", () => {
    const err = new MountSourceNotFoundError("x");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("MountReadonlyError", () => {
  it("carries code MOUNT_READONLY", () => {
    const err = new MountReadonlyError("backlog");
    expect(err.code).toBe("MOUNT_READONLY");
  });

  it("includes mount name in message", () => {
    const err = new MountReadonlyError("backlog");
    expect(err.message).toContain("backlog");
    expect(err.message).toContain("read-only");
  });

  it("has name MountReadonlyError", () => {
    const err = new MountReadonlyError("x");
    expect(err.name).toBe("MountReadonlyError");
  });

  it("is an instance of Error", () => {
    const err = new MountReadonlyError("x");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("MountScopeError", () => {
  it("carries code MOUNT_SCOPE_ERROR", () => {
    const err = new MountScopeError("job");
    expect(err.code).toBe("MOUNT_SCOPE_ERROR");
  });

  it("includes scope and (none) when no target", () => {
    const err = new MountScopeError("agent");
    expect(err.message).toContain("agent");
    expect(err.message).toContain("(none)");
  });

  it("includes scopeTarget when provided", () => {
    const err = new MountScopeError("job", "job-42");
    expect(err.message).toContain("job-42");
  });

  it("has name MountScopeError", () => {
    const err = new MountScopeError("job");
    expect(err.name).toBe("MountScopeError");
  });

  it("is an instance of Error", () => {
    const err = new MountScopeError("job");
    expect(err).toBeInstanceOf(Error);
  });
});
