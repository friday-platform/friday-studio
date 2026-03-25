import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/utils/session-event-stream", () => ({
  fetchSessionView: vi.fn(),
  sessionEventStream: vi.fn(),
}));

const { createInspectorState } = await import("./inspector-state.svelte.ts");

describe("createInspectorState — disabledSteps", () => {
  it("starts with an empty set", () => {
    const state = createInspectorState();
    expect(state.disabledSteps.size).toBe(0);
  });

  it("toggleStep adds a stateId when absent", () => {
    const state = createInspectorState();
    state.toggleStep("step_post_review");
    expect(state.disabledSteps.has("step_post_review")).toBe(true);
  });

  it("toggleStep removes a stateId when present", () => {
    const state = createInspectorState();
    state.toggleStep("step_post_review");
    state.toggleStep("step_post_review");
    expect(state.disabledSteps.has("step_post_review")).toBe(false);
    expect(state.disabledSteps.size).toBe(0);
  });

  it("tracks multiple disabled steps independently", () => {
    const state = createInspectorState();
    state.toggleStep("step_a");
    state.toggleStep("step_b");
    expect(state.disabledSteps.has("step_a")).toBe(true);
    expect(state.disabledSteps.has("step_b")).toBe(true);

    state.toggleStep("step_a");
    expect(state.disabledSteps.has("step_a")).toBe(false);
    expect(state.disabledSteps.has("step_b")).toBe(true);
  });

  it("reset() clears disabledSteps", () => {
    const state = createInspectorState();
    state.toggleStep("step_a");
    state.toggleStep("step_b");
    state.reset();
    expect(state.disabledSteps.size).toBe(0);
  });
});
