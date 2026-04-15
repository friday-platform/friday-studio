import type { ScratchpadAdapter, ScratchpadChunk } from "@atlas/agent-sdk";
import { parse } from "@std/yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@atlas/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { applyFinding } from "../improvement-policy.ts";

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

describe("applyFinding", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("surface mode", () => {
    it("calls scratchpad.append with kind='improvement-proposal' and does NOT call fetch", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const scratchpad = makeScratchpad();
      const proposedConfig = { version: "1.0", workspace: { name: "Updated" } };

      const result = await applyFinding({
        workspaceId: "ws-test",
        cfg: { improvement: "surface" },
        proposedConfig,
        scratchpad,
        daemonBaseUrl: "http://localhost:8080",
      });

      expect(result).toEqual({ mode: "surface", result: "surfaced" });
      expect(scratchpad.append).toHaveBeenCalledOnce();
      expect(scratchpad.append).toHaveBeenCalledWith(
        "ws-test/notes",
        expect.objectContaining({ kind: "improvement-proposal" }),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("returned chunk body is valid YAML of proposedConfig", async () => {
      const scratchpad = makeScratchpad();
      const proposedConfig = { version: "1.0", workspace: { name: "Test" } };

      await applyFinding({
        workspaceId: "ws-test",
        cfg: { improvement: "surface" },
        proposedConfig,
        scratchpad,
        daemonBaseUrl: "http://localhost:8080",
      });

      const appendMock = scratchpad.append as ReturnType<typeof vi.fn>;
      const chunk = appendMock.mock.calls[0]?.[1] as ScratchpadChunk;
      expect(parse(chunk.body)).toEqual(proposedConfig);
    });

    it("writes a ScratchpadChunk with valid createdAt ISO timestamp", async () => {
      const scratchpad = makeScratchpad();

      await applyFinding({
        workspaceId: "ws-test",
        cfg: { improvement: "surface" },
        proposedConfig: { version: "1.0" },
        scratchpad,
        daemonBaseUrl: "http://localhost:8080",
      });

      const appendMock = scratchpad.append as ReturnType<typeof vi.fn>;
      const chunk = appendMock.mock.calls[0]?.[1] as ScratchpadChunk;
      expect(chunk.createdAt).toBeDefined();
      expect(new Date(chunk.createdAt).toISOString()).toBe(chunk.createdAt);
    });

    it("defaults to surface when no improvement flag is set", async () => {
      const scratchpad = makeScratchpad();

      const result = await applyFinding({
        workspaceId: "ws-test",
        cfg: {},
        proposedConfig: { version: "1.0" },
        scratchpad,
        daemonBaseUrl: "http://localhost:8080",
      });

      expect(result).toEqual({ mode: "surface", result: "surfaced" });
      expect(scratchpad.append).toHaveBeenCalledOnce();
    });
  });

  describe("auto mode", () => {
    it("calls POST /api/workspaces/:id/update?backup=true with full config body", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const scratchpad = makeScratchpad();
      const proposedConfig = { version: "1.0", workspace: { name: "Auto" } };

      const result = await applyFinding({
        workspaceId: "ws-auto",
        cfg: { improvement: "auto" },
        proposedConfig,
        scratchpad,
        daemonBaseUrl: "http://localhost:8080",
      });

      expect(result).toEqual({ mode: "auto", result: "applied" });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:8080/api/workspaces/ws-auto/update?backup=true",
        expect.objectContaining({ method: "POST", body: JSON.stringify(proposedConfig) }),
      );
      expect(scratchpad.append).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("throws when daemon returns non-2xx", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Not found", { status: 404 }));
      const scratchpad = makeScratchpad();

      await expect(
        applyFinding({
          workspaceId: "ws-test",
          cfg: { improvement: "auto" },
          proposedConfig: { version: "1.0" },
          scratchpad,
          daemonBaseUrl: "http://localhost:8080",
        }),
      ).rejects.toThrow("Daemon update failed: 404");

      vi.mocked(globalThis.fetch).mockRestore();
    });
  });

  describe("job-level override", () => {
    it("uses job policy over workspace policy", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}", { status: 200 }));
      const scratchpad = makeScratchpad();

      const result = await applyFinding({
        workspaceId: "ws-test",
        jobId: "scan-job",
        cfg: { improvement: "surface", jobs: { "scan-job": { improvement: "auto" } } },
        proposedConfig: { version: "1.0" },
        scratchpad,
        daemonBaseUrl: "http://localhost:8080",
      });

      expect(result).toEqual({ mode: "auto", result: "applied" });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(scratchpad.append).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });
});
