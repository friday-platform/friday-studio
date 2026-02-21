import { beforeEach, describe, expect, test, vi } from "vitest";
import type { UploadStatus } from "../utils/upload.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — intercept ../utils/upload so the real controller uses our stubs
// ─────────────────────────────────────────────────────────────────────────────

const mockValidateFile = vi.hoisted(() => vi.fn());
const mockUploadFile = vi.hoisted(() => vi.fn());

vi.mock("../utils/upload", () => ({ validateFile: mockValidateFile, uploadFile: mockUploadFile }));

// Import the REAL controller — it imports from ../utils/upload which is mocked above
const { createUploadController } = await import("./upload-controller.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createTestFile(name: string, size: number): File {
  return new File([new ArrayBuffer(size)], name, { type: "text/csv" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — exercises the real createUploadController, not a copy
// ─────────────────────────────────────────────────────────────────────────────

describe("upload-controller", () => {
  let onchange: ReturnType<typeof vi.fn<(artifactId: string | undefined) => void>>;

  beforeEach(() => {
    mockValidateFile.mockReset();
    mockUploadFile.mockReset();
    onchange = vi.fn<(artifactId: string | undefined) => void>();
  });

  test("starts in idle state", () => {
    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });

    expect(ctrl.status).toBe("idle");
    expect(ctrl.file).toBeNull();
    expect(ctrl.uploading).toBe(false);
  });

  test("shows error for invalid file without starting upload", () => {
    mockValidateFile.mockReturnValue({ valid: false, error: "Unsupported file type." });

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    const file = createTestFile("bad.xyz", 100);
    ctrl.handleFile(file);

    expect(ctrl.status).toBe("error");
    expect(ctrl.errorMessage).toBe("Unsupported file type.");
    expect(ctrl.uploading).toBe(false);
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(onchange).toHaveBeenCalledWith(undefined);
  });

  test("sets uploading status during upload", () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockReturnValue(new Promise(() => {})); // never resolves

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    const file = createTestFile("data.csv", 1024);
    ctrl.handleFile(file);

    expect(ctrl.status).toBe("uploading");
    expect(ctrl.uploading).toBe(true);
    expect(ctrl.file?.name).toBe("data.csv");
  });

  test("tracks progress via onProgress callback", () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockImplementation(
      (_file: File, _chatId: string | undefined, onProgress: (loaded: number) => void) => {
        onProgress(500);
        onProgress(1024);
        return new Promise(() => {}); // never resolves
      },
    );

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    ctrl.handleFile(createTestFile("data.csv", 1024));

    expect(ctrl.progress).toBe(1024);
  });

  test("transitions to converting state via onStatusChange", () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockImplementation(
      (
        _file: File,
        _chatId: string | undefined,
        _onProgress: (loaded: number) => void,
        _signal: AbortSignal,
        onStatusChange: (status: UploadStatus) => void,
      ) => {
        onStatusChange("converting");
        return new Promise(() => {}); // never resolves
      },
    );

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    ctrl.handleFile(createTestFile("report.pdf", 2048));

    expect(ctrl.status).toBe("converting");
    expect(ctrl.uploading).toBe(true);
  });

  test("transitions to ready and fires onchange with artifactId on success", async () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockResolvedValue({ artifactId: "art-123" });

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    ctrl.handleFile(createTestFile("data.csv", 1024));

    await vi.waitFor(() => {
      expect(ctrl.status).toBe("ready");
    });

    expect(ctrl.uploading).toBe(false);
    expect(onchange).toHaveBeenCalledWith("art-123");
  });

  test("onUpdate fires at each state transition during happy path", async () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockResolvedValue({ artifactId: "art-update" });

    const onUpdate = vi.fn();
    const ctrl = createUploadController({ onchange, onUpdate });
    ctrl.handleFile(createTestFile("data.csv", 1024));

    await vi.waitFor(() => {
      expect(ctrl.status).toBe("ready");
    });

    // onUpdate should fire at least twice: once for uploading, once for ready
    expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("transitions to error and fires onchange(undefined) on upload failure", async () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockResolvedValue({ error: "Network error" });

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    ctrl.handleFile(createTestFile("data.csv", 1024));

    await vi.waitFor(() => {
      expect(ctrl.status).toBe("error");
    });

    expect(ctrl.errorMessage).toBe("Network error");
    expect(ctrl.uploading).toBe(false);
    expect(onchange).toHaveBeenCalledWith(undefined);
  });

  test("cancel resets to idle and fires onchange(undefined)", () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockReturnValue(new Promise(() => {}));

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    ctrl.handleFile(createTestFile("data.csv", 1024));

    expect(ctrl.uploading).toBe(true);

    ctrl.cancel();

    expect(ctrl.status).toBe("idle");
    expect(ctrl.file).toBeNull();
    expect(ctrl.uploading).toBe(false);
    expect(onchange).toHaveBeenCalledWith(undefined);
  });

  test("cancel fires onchange(undefined)", () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockResolvedValue({ artifactId: "art-456" });

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    ctrl.handleFile(createTestFile("data.csv", 1024));
    ctrl.cancel();

    expect(onchange).toHaveBeenCalledWith(undefined);
  });

  test("does not fire onchange on cancelled upload error", async () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockResolvedValue({ error: "Upload cancelled" });

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    ctrl.handleFile(createTestFile("data.csv", 1024));

    // Flush all microtasks (setTimeout(0) drains the microtask queue first)
    await new Promise((r) => setTimeout(r, 0));

    expect(onchange).not.toHaveBeenCalled();
  });

  test("passes no chatId to uploadFile", () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockReturnValue(new Promise(() => {}));

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    ctrl.handleFile(createTestFile("data.csv", 1024));

    expect(mockUploadFile).toHaveBeenCalledWith(
      expect.any(File),
      undefined, // no chatId
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  test("retry when idle is a no-op", () => {
    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    ctrl.retry();
    expect(ctrl.status).toBe("idle");
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  test("retry re-triggers upload with the same file", async () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockResolvedValue({ error: "Network error" });

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    const file = createTestFile("data.csv", 1024);
    ctrl.handleFile(file);

    // Wait for error state (matches real user flow: see error, then click retry)
    await vi.waitFor(() => {
      expect(ctrl.status).toBe("error");
    });

    mockUploadFile.mockReturnValue(new Promise(() => {}));
    ctrl.retry();

    expect(mockUploadFile).toHaveBeenCalledTimes(2);
    expect(ctrl.status).toBe("uploading");
  });

  test("transitions to error on unexpected promise rejection", async () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockRejectedValue(new Error("kaboom"));

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    ctrl.handleFile(createTestFile("data.csv", 1024));

    await vi.waitFor(() => {
      expect(ctrl.status).toBe("error");
    });

    expect(ctrl.errorMessage).toBe("Unexpected upload error");
    expect(onchange).toHaveBeenCalledWith(undefined);
  });

  test("double handleFile aborts previous upload before starting new one", () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockReturnValue(new Promise(() => {}));

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });

    ctrl.handleFile(createTestFile("first.csv", 1024));
    expect(ctrl.uploading).toBe(true);

    ctrl.handleFile(createTestFile("second.csv", 2048));

    expect(ctrl.file?.name).toBe("second.csv");
    expect(ctrl.status).toBe("uploading");
  });

  test("stale promise from aborted upload does not corrupt state", async () => {
    mockValidateFile.mockReturnValue({ valid: true });

    // First upload: will be aborted, then resolves with success (stale)
    let resolveFirst: (v: { artifactId: string }) => void;
    mockUploadFile.mockReturnValueOnce(
      new Promise((r) => {
        resolveFirst = r;
      }),
    );

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    ctrl.handleFile(createTestFile("first.csv", 1024));

    // Start second upload (aborts first)
    mockUploadFile.mockReturnValue(new Promise(() => {}));
    ctrl.handleFile(createTestFile("second.csv", 2048));

    // First promise resolves with success — but it's stale
    resolveFirst!({ artifactId: "stale-art-id" });
    await new Promise<void>((r) => queueMicrotask(r));

    // State should still show second file uploading — stale result ignored
    expect(ctrl.file?.name).toBe("second.csv");
    expect(ctrl.status).toBe("uploading");
    expect(onchange).not.toHaveBeenCalled();
  });

  test("destroy aborts in-flight upload and fires onchange(undefined)", () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockReturnValue(new Promise(() => {}));

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    ctrl.handleFile(createTestFile("data.csv", 1024));

    expect(ctrl.uploading).toBe(true);

    ctrl.destroy();

    expect(onchange).toHaveBeenCalledWith(undefined);
  });

  test("destroy fires onchange(undefined) when idle", () => {
    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });

    ctrl.destroy();

    expect(onchange).toHaveBeenCalledWith(undefined);
  });

  test("destroy does NOT fire onchange(undefined) when upload is ready", async () => {
    mockValidateFile.mockReturnValue({ valid: true });
    mockUploadFile.mockResolvedValue({ artifactId: "art-keep" });

    const ctrl = createUploadController({ onchange, onUpdate: vi.fn() });
    ctrl.handleFile(createTestFile("data.csv", 1024));

    await vi.waitFor(() => {
      expect(ctrl.status).toBe("ready");
    });

    onchange.mockClear();
    ctrl.destroy();

    // Should NOT clear the completed artifact ID
    expect(onchange).not.toHaveBeenCalled();
  });
});
