import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@atlas/oapi-client", () => ({ getAtlasDaemonUrl: () => "http://localhost:8080" }));

describe("activity-stream", () => {
  let instances: Array<{
    onmessage: ((event: MessageEvent) => void) | null;
    close: ReturnType<typeof vi.fn>;
  }>;
  let MockEventSource: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    instances = [];
    MockEventSource = vi.fn(function MockES(this: Record<string, unknown>) {
      this.onmessage = null;
      this.close = vi.fn();
      instances.push(this as (typeof instances)[number]);
    });
    vi.stubGlobal("EventSource", MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function loadModule() {
    return await import("./activity-stream.ts");
  }

  it("startActivityStream is idempotent — calling twice creates one EventSource", async () => {
    const { startActivityStream } = await loadModule();

    startActivityStream();
    startActivityStream();

    expect(MockEventSource).toHaveBeenCalledOnce();
    expect(instances).toHaveLength(1);
  });

  it("resetActivityCount sets count to 0", async () => {
    const { startActivityStream, getActivityUnreadCount, resetActivityCount } = await loadModule();

    startActivityStream();

    const [instance] = instances;
    if (!instance) throw new Error("Expected EventSource instance");

    // Simulate an SSE message that sets count
    instance.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ count: 5 }) }));
    expect(getActivityUnreadCount()).toBe(5);

    resetActivityCount();
    expect(getActivityUnreadCount()).toBe(0);
  });
});
