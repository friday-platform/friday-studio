import type { ScratchpadAdapter, ScratchpadChunk } from "@atlas/agent-sdk";
import { stringify as yamlStringify } from "@std/yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@atlas/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { type ApplyFindingDeps, applyFinding, type Finding } from "../improvement-policy.ts";

function makeScratchpad(): ScratchpadAdapter {
  return {
    append: vi
      .fn<(sessionKey: string, chunk: ScratchpadChunk) => Promise<void>>()
      .mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    promote: vi.fn().mockResolvedValue({ id: "1", text: "", createdAt: "" }),
  };
}

function makeFinding(overrides?: Partial<Finding>): Finding {
  return {
    workspaceId: "ws-test",
    sessionKey: "session-1",
    proposedConfig: { version: "1.0", workspace: { name: "Updated" } },
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<ApplyFindingDeps>): ApplyFindingDeps {
  return { scratchpad: makeScratchpad(), daemonBaseUrl: "http://localhost:8080", ...overrides };
}

describe("applyFinding", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("surface mode", () => {
    it("calls ScratchpadAdapter.append with kind='proposed-config' and YAML body", async () => {
      const deps = makeDeps();
      const finding = makeFinding();

      await applyFinding({ improvement: "surface" }, finding, deps);

      expect(deps.scratchpad.append).toHaveBeenCalledOnce();
      expect(deps.scratchpad.append).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          kind: "proposed-config",
          body: yamlStringify(finding.proposedConfig),
        }),
      );
    });

    it("writes a ScratchpadChunk with valid createdAt ISO timestamp", async () => {
      const deps = makeDeps();
      await applyFinding({ improvement: "surface" }, makeFinding(), deps);

      const appendMock = deps.scratchpad.append as ReturnType<typeof vi.fn>;
      const chunk = appendMock.mock.calls[0]?.[1] as ScratchpadChunk;
      expect(chunk.createdAt).toBeDefined();
      expect(new Date(chunk.createdAt).toISOString()).toBe(chunk.createdAt);
    });

    it("defaults to surface when no improvement flag is set", async () => {
      const deps = makeDeps();
      await applyFinding({}, makeFinding(), deps);
      expect(deps.scratchpad.append).toHaveBeenCalledOnce();
    });

    it("does not make any HTTP request", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const deps = makeDeps();

      await applyFinding({ improvement: "surface" }, makeFinding(), deps);

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  describe("auto mode", () => {
    it("POSTs to /api/workspaces/:id/update with backup=true", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const deps = makeDeps();
      const finding = makeFinding({ workspaceId: "ws-auto" });

      await applyFinding({ improvement: "auto" }, finding, deps);

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:8080/api/workspaces/ws-auto/update",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ config: finding.proposedConfig, backup: true }),
        }),
      );
      fetchSpy.mockRestore();
    });

    it("does not call ScratchpadAdapter", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      const deps = makeDeps();

      await applyFinding({ improvement: "auto" }, makeFinding(), deps);

      expect(deps.scratchpad.append).not.toHaveBeenCalled();
      vi.mocked(globalThis.fetch).mockRestore();
    });

    it("throws on HTTP error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Not found", { status: 404 }));
      const deps = makeDeps();

      await expect(applyFinding({ improvement: "auto" }, makeFinding(), deps)).rejects.toThrow(
        "Auto-mode update failed (404)",
      );

      vi.mocked(globalThis.fetch).mockRestore();
    });
  });

  describe("job-level override", () => {
    it("uses job policy over workspace policy", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}", { status: 200 }));
      const deps = makeDeps();
      const finding = makeFinding({ jobId: "scan-job" });

      await applyFinding(
        { improvement: "surface", jobs: { "scan-job": { improvement: "auto" } } },
        finding,
        deps,
      );

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(deps.scratchpad.append).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });
});
