import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @opentelemetry/api before importing the module under test
const mockSpan = {
  setAttributes: vi.fn(),
  setAttribute: vi.fn(),
  recordException: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
  isRecording: vi.fn(() => true),
};

// Lightweight probe span returned during resolveTracer's isRecording() check
const probeSpan = { isRecording: () => true, end: vi.fn() };

const mockTracer = {
  startActiveSpan: vi.fn(
    (
      _name: string,
      _options: Record<string, unknown>,
      fn: (span: typeof mockSpan) => Promise<unknown>,
    ) => fn(mockSpan),
  ),
  startSpan: vi.fn((name: string, _options: Record<string, unknown>) =>
    name === "atlas.probe" ? probeSpan : mockSpan,
  ),
};

vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: () => mockTracer,
    getTracerProvider: () => ({ constructor: { name: "MockProvider" } }),
  },
}));

describe("withOtelSpan", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("OTEL_DENO", "true");
    vi.resetAllMocks();
    // Restore implementations after reset
    mockTracer.startActiveSpan.mockImplementation(
      (
        _name: string,
        _options: Record<string, unknown>,
        fn: (span: typeof mockSpan) => Promise<unknown>,
      ) => fn(mockSpan),
    );
    mockTracer.startSpan.mockImplementation((name: string) =>
      name === "atlas.probe" ? probeSpan : mockSpan,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a span with correct name and attributes when OTEL_DENO=true", async () => {
    const { withOtelSpan } = await import("./telemetry.ts");

    const result = await withOtelSpan(
      "test.span",
      { "test.attr": "value", "test.num": 42 },
      (span) => {
        expect(span).not.toBeNull();
        return Promise.resolve("ok");
      },
    );

    expect(result).toBe("ok");
    expect(mockTracer.startActiveSpan).toHaveBeenCalledWith(
      "test.span",
      { attributes: { "test.attr": "value", "test.num": 42 } },
      expect.any(Function),
    );
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it("passes null span and skips OTEL when OTEL_DENO is not set", async () => {
    vi.stubEnv("OTEL_DENO", "");

    const { withOtelSpan } = await import("./telemetry.ts");

    const result = await withOtelSpan("test.span", {}, (span) => {
      expect(span).toBeNull();
      return Promise.resolve("bypassed");
    });

    expect(result).toBe("bypassed");
    expect(mockTracer.startActiveSpan).not.toHaveBeenCalled();
  });

  it("records exception and sets error status on failure", async () => {
    const { withOtelSpan } = await import("./telemetry.ts");
    const error = new Error("test failure");

    await expect(withOtelSpan("test.span", {}, () => Promise.reject(error))).rejects.toThrow(
      "test failure",
    );

    expect(mockSpan.recordException).toHaveBeenCalledWith(error);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: "Error: test failure" });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it("allows fn to set additional attributes on span", async () => {
    const { withOtelSpan } = await import("./telemetry.ts");

    await withOtelSpan("test.span", { initial: true }, (span) => {
      span?.setAttribute("dynamic.attr", 123);
      return Promise.resolve("done");
    });

    expect(mockSpan.setAttribute).toHaveBeenCalledWith("dynamic.attr", 123);
  });
});

describe("startOtelSpan", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("OTEL_DENO", "true");
    vi.resetAllMocks();
    mockTracer.startSpan.mockImplementation((name: string) =>
      name === "atlas.probe" ? probeSpan : mockSpan,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a span when OTEL is enabled", async () => {
    const { startOtelSpan } = await import("./telemetry.ts");

    const span = await startOtelSpan("test.span", { "test.attr": "value" });

    expect(span).toBe(mockSpan);
    expect(mockTracer.startSpan).toHaveBeenCalledWith("test.span", {
      attributes: { "test.attr": "value" },
    });
  });

  it("returns null when OTEL is disabled", async () => {
    vi.stubEnv("OTEL_DENO", "");

    const { startOtelSpan } = await import("./telemetry.ts");

    const span = await startOtelSpan("test.span", {});

    expect(span).toBeNull();
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  it("does not auto-end the span", async () => {
    const { startOtelSpan } = await import("./telemetry.ts");

    await startOtelSpan("test.span", {});

    expect(mockSpan.end).not.toHaveBeenCalled();
  });
});
