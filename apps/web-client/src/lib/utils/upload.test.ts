import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { validateFile } from "./upload.ts";

function createTestFile(name: string, size: number, type = ""): File {
  return new File([new ArrayBuffer(size)], name, { type });
}

describe("validateFile", () => {
  test("rejects zero-byte files", () => {
    const result = validateFile(createTestFile("empty.csv", 0, "text/csv"));
    expect(result).toEqual({ valid: false, error: "File is empty." });
  });

  test("accepts valid CSV with MIME type", () => {
    const result = validateFile(createTestFile("data.csv", 100, "text/csv"));
    expect(result).toEqual({ valid: true });
  });

  test("accepts valid CSV by extension fallback", () => {
    const result = validateFile(createTestFile("data.csv", 100));
    expect(result).toEqual({ valid: true });
  });

  test("rejects unsupported file types", () => {
    const result = validateFile(createTestFile("script.exe", 100));
    expect(result.valid).toBe(false);
  });

  test("rejects files over MAX_FILE_SIZE", () => {
    const result = validateFile(createTestFile("huge.csv", 501 * 1024 * 1024, "text/csv"));
    expect(result).toEqual({ valid: false, error: "File too large. Maximum size is 500MB." });
  });

  test("accepts JSON files", () => {
    const result = validateFile(createTestFile("config.json", 50, "application/json"));
    expect(result).toEqual({ valid: true });
  });

  test("accepts PDF files under limit", () => {
    const result = validateFile(createTestFile("doc.pdf", 1024, "application/pdf"));
    expect(result).toEqual({ valid: true });
  });

  test("rejects PDF files over MAX_PDF_SIZE", () => {
    const result = validateFile(createTestFile("huge.pdf", 51 * 1024 * 1024, "application/pdf"));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("PDF");
    }
  });

  test("rejects DOCX files over MAX_OFFICE_SIZE", () => {
    const result = validateFile(
      createTestFile(
        "huge.docx",
        51 * 1024 * 1024,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("DOCX");
    }
  });

  test("rejects PPTX files over MAX_OFFICE_SIZE", () => {
    const result = validateFile(
      createTestFile(
        "huge.pptx",
        51 * 1024 * 1024,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("PPTX");
    }
  });

  test("rejects image files over MAX_IMAGE_SIZE", () => {
    const result = validateFile(createTestFile("huge.png", 6 * 1024 * 1024, "image/png"));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Image");
    }
  });

  test("accepts markdown files by extension", () => {
    const result = validateFile(createTestFile("README.md", 100));
    expect(result).toEqual({ valid: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// uploadFile tests — mock XHR and fetch, test the real upload functions
// ─────────────────────────────────────────────────────────────────────────────

// Mock getAtlasDaemonUrl before importing uploadFile
vi.mock("@atlas/oapi-client", () => ({ getAtlasDaemonUrl: () => "http://localhost:8080" }));

// Dynamic import so the mock is in place
const { uploadFile } = await import("./upload.ts");

/** Minimal XHR stub that simulates browser XMLHttpRequest behavior. */
function createMockXHR(response: { status: number; body: string }) {
  let onloadFn: (() => void) | null = null;
  let onerrorFn: (() => void) | null = null;
  let onabortFn: (() => void) | null = null;
  let onprogressFn: ((e: { lengthComputable: boolean; loaded: number }) => void) | null = null;

  const xhr = {
    open: vi.fn(),
    send: vi.fn(),
    abort: vi.fn(),
    status: response.status,
    responseText: response.body,
    upload: {
      set onprogress(fn: typeof onprogressFn) {
        onprogressFn = fn;
      },
    },
    set onload(fn: typeof onloadFn) {
      onloadFn = fn;
    },
    set onerror(fn: typeof onerrorFn) {
      onerrorFn = fn;
    },
    set onabort(fn: typeof onabortFn) {
      onabortFn = fn;
    },
    addEventListener: vi.fn(),
    // Fire events for test control
    _fireLoad: () => onloadFn?.(),
    _fireError: () => onerrorFn?.(),
    _fireAbort: () => onabortFn?.(),
    _fireProgress: (loaded: number) => onprogressFn?.({ lengthComputable: true, loaded }),
  };

  return xhr;
}

describe("uploadFile (simple path)", () => {
  let xhrInstance: ReturnType<typeof createMockXHR>;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    xhrInstance = createMockXHR({
      status: 200,
      body: JSON.stringify({ artifact: { id: "art-simple-1" } }),
    });

    // Use a class so `new XMLHttpRequest()` works
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        open = xhrInstance.open;
        send = xhrInstance.send;
        abort = xhrInstance.abort;
        addEventListener = xhrInstance.addEventListener;
        upload = xhrInstance.upload;
        get status() {
          return xhrInstance.status;
        }
        get responseText() {
          return xhrInstance.responseText;
        }
        set onload(fn: (() => void) | null) {
          xhrInstance.onload = fn;
        }
        set onerror(fn: (() => void) | null) {
          xhrInstance.onerror = fn;
        }
        set onabort(fn: (() => void) | null) {
          xhrInstance.onabort = fn;
        }
      },
    );
  });

  test("returns artifactId on successful upload", async () => {
    const file = createTestFile("data.csv", 100, "text/csv");
    const promise = uploadFile(file);

    // XHR send was called — simulate server response
    xhrInstance._fireLoad();

    const result = await promise;
    expect(result).toEqual({ artifactId: "art-simple-1" });
    expect(xhrInstance.open).toHaveBeenCalledWith(
      "POST",
      "http://localhost:8080/api/artifacts/upload",
    );
  });

  test("returns error on server error response", async () => {
    xhrInstance.status = 500;
    xhrInstance.responseText = JSON.stringify({ error: "Internal server error" });

    const promise = uploadFile(createTestFile("data.csv", 100, "text/csv"));
    xhrInstance._fireLoad();

    const result = await promise;
    expect(result).toEqual({ error: "Internal server error" });
  });

  test("returns error on invalid JSON response", async () => {
    xhrInstance.responseText = "not-json";

    const promise = uploadFile(createTestFile("data.csv", 100, "text/csv"));
    xhrInstance._fireLoad();

    const result = await promise;
    expect(result).toEqual({ error: "Invalid response from server" });
  });

  test("returns error on network failure", async () => {
    const promise = uploadFile(createTestFile("data.csv", 100, "text/csv"));
    xhrInstance._fireError();

    const result = await promise;
    expect(result).toEqual({ error: "Network error" });
  });

  test("returns error on abort", async () => {
    const promise = uploadFile(createTestFile("data.csv", 100, "text/csv"));
    xhrInstance._fireAbort();

    const result = await promise;
    expect(result).toEqual({ error: "Upload cancelled" });
  });

  test("tracks upload progress", async () => {
    const progressValues: number[] = [];
    const promise = uploadFile(createTestFile("data.csv", 1000, "text/csv"), undefined, (loaded) =>
      progressValues.push(loaded),
    );

    xhrInstance._fireProgress(500);
    xhrInstance._fireProgress(1000);
    xhrInstance._fireLoad();

    await promise;
    expect(progressValues).toEqual([500, 1000]);
  });

  test("returns error when response body has wrong shape", async () => {
    xhrInstance.responseText = JSON.stringify({ unexpected: "shape" });

    const promise = uploadFile(createTestFile("data.csv", 100, "text/csv"));
    xhrInstance._fireLoad();

    const result = await promise;
    expect(result).toEqual({ error: "Invalid response from server" });
  });

  test("includes chatId in FormData when provided", async () => {
    const promise = uploadFile(createTestFile("data.csv", 100, "text/csv"), "chat-123");
    xhrInstance._fireLoad();

    await promise;
    const sentData = xhrInstance.send.mock.calls[0]?.[0];
    expect(sentData).toBeInstanceOf(FormData);
    if (sentData instanceof FormData) {
      expect(sentData.get("chatId")).toBe("chat-123");
    }
  });

  test("aborts XHR when signal fires", async () => {
    const controller = new AbortController();
    const promise = uploadFile(
      createTestFile("data.csv", 100, "text/csv"),
      undefined,
      undefined,
      controller.signal,
    );

    // Trigger abort — this should call xhr.abort() via the signal listener
    controller.abort();
    xhrInstance._fireAbort();

    const result = await promise;
    expect(result).toEqual({ error: "Upload cancelled" });
  });
});

describe("uploadFile (chunked path)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("uses chunked upload for large files and returns artifactId", async () => {
    // Mock fetch for chunked upload flow
    const mockFetch = vi.fn();

    // 1. Init response
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ uploadId: "upload-1", totalChunks: 2 }), { status: 200 }),
    );
    // 2. Chunk 0
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // 3. Chunk 1
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // 4. Complete
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "completing" }), { status: 202 }),
    );
    // 5. Poll — completed
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: "completed", result: { artifact: { id: "art-chunked-1" } } }),
        { status: 200 },
      ),
    );

    vi.stubGlobal("fetch", mockFetch);

    // Create a file >= CHUNKED_UPLOAD_THRESHOLD (50MB)
    const file = createTestFile("big.csv", 50 * 1024 * 1024, "text/csv");
    const result = await uploadFile(file);

    expect(result).toEqual({ artifactId: "art-chunked-1" });

    // Verify init was called
    expect(mockFetch.mock.calls[0]?.[0]).toBe("http://localhost:8080/api/chunked-upload/init");
    // Verify chunk uploads
    expect(mockFetch.mock.calls[1]?.[0]).toContain("/chunk/0");
    expect(mockFetch.mock.calls[2]?.[0]).toContain("/chunk/1");
    // Verify complete
    expect(mockFetch.mock.calls[3]?.[0]).toContain("/complete");
  });

  test("returns error when init fails", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Quota exceeded" }), { status: 429 }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const file = createTestFile("big.csv", 50 * 1024 * 1024, "text/csv");
    const result = await uploadFile(file);

    expect(result).toEqual({ error: "Quota exceeded" });
  });

  test("returns error on non-retryable chunk failure (4xx)", async () => {
    const mockFetch = vi.fn();

    // Init
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ uploadId: "upload-2", totalChunks: 1 }), { status: 200 }),
    );
    // Chunk 0 — 400 error
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Bad chunk" }), { status: 400 }),
    );

    vi.stubGlobal("fetch", mockFetch);

    const file = createTestFile("big.csv", 50 * 1024 * 1024, "text/csv");
    const result = await uploadFile(file);

    expect(result).toEqual({ error: "Bad chunk" });
  });

  test("calls onStatusChange with converting after complete response", async () => {
    const mockFetch = vi.fn();

    // Init
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ uploadId: "upload-3", totalChunks: 1 }), { status: 200 }),
    );
    // Chunk 0
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // Complete
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "completing" }), { status: 202 }),
    );
    // Poll — completed
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "completed", result: { artifact: { id: "art-3" } } }), {
        status: 200,
      }),
    );

    vi.stubGlobal("fetch", mockFetch);

    const statusChanges: string[] = [];
    const file = createTestFile("big.csv", 50 * 1024 * 1024, "text/csv");
    await uploadFile(file, undefined, undefined, undefined, (s) => statusChanges.push(s));

    expect(statusChanges).toContain("converting");
  });

  test("returns error when conversion fails", async () => {
    const mockFetch = vi.fn();

    // Init
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ uploadId: "upload-4", totalChunks: 1 }), { status: 200 }),
    );
    // Chunk 0
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // Complete
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "completing" }), { status: 202 }),
    );
    // Poll — failed
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "failed", result: { error: "Corrupt file" } }), {
        status: 200,
      }),
    );

    vi.stubGlobal("fetch", mockFetch);

    const file = createTestFile("big.csv", 50 * 1024 * 1024, "text/csv");
    const result = await uploadFile(file);

    expect(result).toEqual({ error: "Corrupt file" });
  });

  test("returns error on network failure during init", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("Network error")));

    const file = createTestFile("big.csv", 50 * 1024 * 1024, "text/csv");
    const result = await uploadFile(file);

    expect(result).toEqual({ error: "Network error during upload init" });
  });

  test("returns upload cancelled when aborted before chunks", async () => {
    const controller = new AbortController();
    controller.abort(); // pre-abort

    const mockFetch = vi.fn();
    // Init succeeds
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ uploadId: "upload-5", totalChunks: 1 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const file = createTestFile("big.csv", 50 * 1024 * 1024, "text/csv");
    const result = await uploadFile(file, undefined, undefined, controller.signal);

    expect(result).toEqual({ error: "Upload cancelled" });
  });

  test("retries chunk on 5xx and succeeds on second attempt", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn();

    // Init
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ uploadId: "upload-retry", totalChunks: 1 }), { status: 200 }),
    );
    // Chunk 0 — 500 first attempt
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    // Chunk 0 — 200 second attempt
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // Complete
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "completing" }), { status: 202 }),
    );
    // Poll — completed
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: "completed", result: { artifact: { id: "art-retry-ok" } } }),
        { status: 200 },
      ),
    );

    vi.stubGlobal("fetch", mockFetch);

    const file = createTestFile("big.csv", 50 * 1024 * 1024, "text/csv");
    const promise = uploadFile(file);

    // Advance past the backoff delay (up to ~1.5s for first retry)
    await vi.advanceTimersByTimeAsync(2000);
    // Advance past the poll delay
    await vi.advanceTimersByTimeAsync(3000);

    const result = await promise;
    expect(result).toEqual({ artifactId: "art-retry-ok" });

    // Verify chunk was attempted twice
    const chunkCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes("/chunk/0"));
    expect(chunkCalls).toHaveLength(2);
  });

  test("returns error after all chunk retries exhausted", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn();

    // Init
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ uploadId: "upload-exhaust", totalChunks: 1 }), { status: 200 }),
    );
    // Chunk 0 — 500 three times (MAX_RETRIES = 3)
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    // Resume status check (MAX_RESUME_ATTEMPTS = 1)
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ completedChunks: [] }), { status: 200 }),
    );
    // Retry chunk 0 after resume — still fails 3 more times
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));

    vi.stubGlobal("fetch", mockFetch);

    const file = createTestFile("big.csv", 50 * 1024 * 1024, "text/csv");
    const promise = uploadFile(file);

    // Advance enough time for all retries + backoff
    await vi.advanceTimersByTimeAsync(30000);

    const result = await promise;
    expect(result).toEqual({ error: "Failed to upload chunk 0 after 3 attempts" });
  });

  test("retries chunk on network error and succeeds", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn();

    // Init
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ uploadId: "upload-neterr", totalChunks: 1 }), { status: 200 }),
    );
    // Chunk 0 — network error first attempt
    mockFetch.mockRejectedValueOnce(new Error("fetch failed"));
    // Chunk 0 — 200 second attempt
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // Complete
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "completing" }), { status: 202 }),
    );
    // Poll — completed
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: "completed", result: { artifact: { id: "art-net-ok" } } }),
        { status: 200 },
      ),
    );

    vi.stubGlobal("fetch", mockFetch);

    const file = createTestFile("big.csv", 50 * 1024 * 1024, "text/csv");
    const promise = uploadFile(file);

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(3000);

    const result = await promise;
    expect(result).toEqual({ artifactId: "art-net-ok" });
  });

  test("tracks progress via onProgress callback per chunk", async () => {
    const mockFetch = vi.fn();

    // Init — 2 chunks
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ uploadId: "upload-prog", totalChunks: 2 }), { status: 200 }),
    );
    // Chunk 0
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // Chunk 1
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // Complete
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "completing" }), { status: 202 }),
    );
    // Poll — completed
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: "completed", result: { artifact: { id: "art-prog" } } }),
        { status: 200 },
      ),
    );

    vi.stubGlobal("fetch", mockFetch);

    const progressValues: number[] = [];
    const file = createTestFile("big.csv", 50 * 1024 * 1024, "text/csv");
    await uploadFile(file, undefined, (loaded) => progressValues.push(loaded));

    // Should have at least 2 chunk progress reports + 1 final (file.size)
    expect(progressValues.length).toBeGreaterThanOrEqual(2);
    // Last progress value should be the full file size (from complete phase)
    expect(progressValues[progressValues.length - 1]).toBe(file.size);
  });

  test("polls multiple times when status is still completing", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn();

    // Init
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ uploadId: "upload-poll", totalChunks: 1 }), { status: 200 }),
    );
    // Chunk 0
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // Complete
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "completing" }), { status: 202 }),
    );
    // Poll 1 — still completing
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "completing" }), { status: 200 }),
    );
    // Poll 2 — completed
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: "completed", result: { artifact: { id: "art-poll" } } }),
        { status: 200 },
      ),
    );

    vi.stubGlobal("fetch", mockFetch);

    const file = createTestFile("big.csv", 50 * 1024 * 1024, "text/csv");
    const promise = uploadFile(file);

    // Advance past both poll intervals (2s each)
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);

    const result = await promise;
    expect(result).toEqual({ artifactId: "art-poll" });

    // Verify two status polls happened
    const statusCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes("/status"));
    expect(statusCalls).toHaveLength(2);
  });

  test("returns error when complete endpoint fails", async () => {
    const mockFetch = vi.fn();

    // Init
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ uploadId: "upload-cfail", totalChunks: 1 }), { status: 200 }),
    );
    // Chunk 0
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // Complete — 500 error
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Storage backend unavailable" }), { status: 500 }),
    );

    vi.stubGlobal("fetch", mockFetch);

    const file = createTestFile("big.csv", 50 * 1024 * 1024, "text/csv");
    const result = await uploadFile(file);

    expect(result).toEqual({ error: "Storage backend unavailable" });
  });

  test("returns error when poll gets 404 (session expired)", async () => {
    const mockFetch = vi.fn();

    // Init
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ uploadId: "upload-6", totalChunks: 1 }), { status: 200 }),
    );
    // Chunk 0
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // Complete
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "completing" }), { status: 202 }),
    );
    // Poll — 404
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));

    vi.stubGlobal("fetch", mockFetch);

    const file = createTestFile("big.csv", 50 * 1024 * 1024, "text/csv");
    const result = await uploadFile(file);

    expect(result).toEqual({ error: "Upload session expired" });
  });
});
