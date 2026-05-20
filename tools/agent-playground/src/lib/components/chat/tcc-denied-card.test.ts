/**
 * Tests for `tcc-denied-card.svelte` — the macOS TCC affordance card the
 * agent shows when `run_code` (or a future file-io variant) hits `Operation
 * not permitted` against `~/Downloads`, `~/Desktop`, or `~/Documents`.
 *
 * Render-only assertions (no DOM event simulation) since `svelte/server`
 * does an SSR pass that captures everything the user would see on first
 * paint, which is what we care about for the affordance's content + the
 * presence of click targets. Behavior of the click handlers (clipboard,
 * deeplink) is exercised in QA, not unit tests.
 */

import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import TccDeniedCard from "./tcc-denied-card.svelte";

const baseDenial = {
  kind: "tcc-denied" as const,
  protectedRoot: "/Users/friday/Downloads",
  attemptedPath: "/Users/friday/Downloads/bucketlist-cs/agents",
  guidance:
    "Friday Studio doesn't have macOS permission to read ~/Downloads. Grant it in System Settings → Privacy & Security → Files & Folders, then retry.",
  actions: [
    {
      label: "Open System Settings",
      type: "open-url" as const,
      payload: "x-apple.systempreferences:com.apple.preference.security?Privacy_Files_Folders",
    },
    {
      label: "Move out of ~/Downloads",
      type: "copy-shell" as const,
      payload: "mv '/Users/friday/Downloads/bucketlist-cs/agents' '/Users/friday/agents'",
    },
  ],
};

describe("tcc-denied-card", () => {
  it("renders the eyebrow, guidance text, and the attempted path verbatim", () => {
    const { body } = render(TccDeniedCard, { props: { denial: baseDenial } });
    expect(body).toContain("macOS permission needed");
    expect(body).toContain("Friday Studio doesn't have macOS permission");
    expect(body).toContain("/Users/friday/Downloads/bucketlist-cs/agents");
  });

  it("renders one button per action with its label", () => {
    const { body } = render(TccDeniedCard, { props: { denial: baseDenial } });
    expect(body).toContain("Open System Settings");
    expect(body).toContain("Move out of ~/Downloads");
    // Buttons are <button>s rendered by the @atlas/ui Button component.
    const buttonCount = (body.match(/<button\b/g) ?? []).length;
    expect(buttonCount).toBe(2);
  });

  it("scopes the affordance to the region role for accessibility", () => {
    const { body } = render(TccDeniedCard, { props: { denial: baseDenial } });
    expect(body).toContain('role="region"');
    expect(body).toContain('aria-label="macOS permission needed"');
  });

  it("renders even when only one action is provided", () => {
    const { body } = render(TccDeniedCard, {
      props: {
        denial: { ...baseDenial, actions: [baseDenial.actions[0]] },
      },
    });
    expect(body).toContain("Open System Settings");
    expect(body).not.toContain("Move out of");
  });
});
