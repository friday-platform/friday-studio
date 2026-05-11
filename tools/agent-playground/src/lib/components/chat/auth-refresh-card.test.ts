import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";

// `@atlas/ui` is a single-entry barrel that pulls in @tanstack/svelte-table and
// other heavy deps on load. The card only uses `Button`; stub it with a plain
// <button> so the test stays light.
vi.mock("@atlas/ui", async () => {
  const mod = await import("./__test-stubs__/button-stub.svelte");
  return { Button: mod.default };
});

const { default: AuthRefreshCard } = await import("./auth-refresh-card.svelte");

describe("AuthRefreshCard", () => {
  it("renders Retry and Cancel buttons with stable testids", () => {
    const { body } = render(AuthRefreshCard, {
      props: {
        elicitationId: "elc_1",
        question: "Refresh credential for Gmail?",
        inFlight: false,
        onanswer: () => {},
      },
    });
    expect(body).toContain('data-testid="auth-refresh-inline-card"');
    expect(body).toContain('data-elicitation-id="elc_1"');
    expect(body).toContain('data-testid="elicitation-auth-refresh-retry"');
    expect(body).toContain('data-testid="elicitation-auth-refresh-cancel"');
    expect(body).toContain("Refresh credential for Gmail?");
    expect(body).toContain("Retry");
    expect(body).toContain("Cancel");
  });

  it("swaps labels and disables buttons while a mutation is in flight", () => {
    const { body } = render(AuthRefreshCard, {
      props: { elicitationId: "elc_1", question: "Refresh?", inFlight: true, onanswer: () => {} },
    });
    expect(body).toContain("Answering…");
    expect(body).toContain("disabled");
    expect(body).not.toMatch(/>Retry</);
    expect(body).not.toMatch(/>Cancel</);
  });

  it("surfaces an error message when present", () => {
    const { body } = render(AuthRefreshCard, {
      props: {
        elicitationId: "elc_1",
        question: "Refresh?",
        inFlight: false,
        errorMessage: "network down",
        onanswer: () => {},
      },
    });
    expect(body).toContain("Answer failed: network down");
  });

  it("hides the error block when no error is provided", () => {
    const { body } = render(AuthRefreshCard, {
      props: { elicitationId: "elc_1", question: "Refresh?", inFlight: false, onanswer: () => {} },
    });
    expect(body).not.toContain("Answer failed");
  });
});
