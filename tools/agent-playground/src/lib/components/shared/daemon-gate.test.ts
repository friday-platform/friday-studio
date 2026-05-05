import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";

// `@atlas/ui` is a barrel that pulls @tanstack/svelte-table on load. The gate
// only references `Button`; stub it with an empty SVG component so the test
// graph doesn't drag in svelte-table.
vi.mock("@atlas/ui", async () => {
  const mod = await import("../chat/__test-stubs__/icon-stub.svelte");
  const Stub = mod.default;
  return { Button: Stub };
});

const { default: DaemonGateChildren } = await import(
  "../__test-stubs__/daemon-gate-children.svelte"
);

describe("daemon-gate", () => {
  // The export preview route opts into SSR with csr=false. DaemonGate
  // initializes `daemonHealth.loading=true` (only flips after a client-side
  // fetch resolves). Without a `browser` guard the SSR'd HTML is forever
  // stuck on the "Connecting to daemon..." branch — the chat transcript
  // never renders. In SSR (and any non-browser execution) the gate must
  // pass children through.
  it("passes children through during SSR (browser=false)", () => {
    const { body } = render(DaemonGateChildren);

    expect(body).toContain("CHILD_CONTENT");
    expect(body).not.toContain("Connecting to daemon...");
    expect(body).not.toContain("Reconnecting to Friday Studio");
  });
});
