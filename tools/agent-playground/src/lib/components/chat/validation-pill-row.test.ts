import { describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import type { ValidationVerdict } from "@atlas/hallucination/verdict";

// `@atlas/ui` is a single-entry barrel that pulls @tanstack/svelte-table on
// load. The component only needs five icons; stub them with an empty SVG
// component so the test does not drag the table dep into Vitest's graph.
vi.mock("@atlas/ui", async () => {
  const mod = await import("./__test-stubs__/icon-stub.svelte");
  const Stub = mod.default;
  return {
    IconSmall: {
      CheckCircle: Stub,
      XCircle: Stub,
      Clock: Stub,
      ChevronRight: Stub,
      ChevronDown: Stub,
    },
  };
});

const { default: ValidationPillRow } = await import("./validation-pill-row.svelte");

function passVerdict(): ValidationVerdict {
  return {
    status: "pass",
    confidence: 0.82,
    threshold: 0.45,
    issues: [],
    retryGuidance: "",
  };
}

function uncertainVerdict(): ValidationVerdict {
  return {
    status: "uncertain",
    confidence: 0.4,
    threshold: 0.45,
    issues: [
      {
        category: "judge-uncertain",
        severity: "info",
        claim: "Computed timezone offset for Tokyo",
        reasoning: "Judge is unsure whether UTC+9 was correctly applied.",
        citation: null,
      },
    ],
    retryGuidance: "",
  };
}

function failVerdict(retryGuidance = "Re-run with explicit citations."): ValidationVerdict {
  return {
    status: "fail",
    confidence: 0.18,
    threshold: 0.45,
    issues: [
      {
        category: "sourcing",
        severity: "error",
        claim: "Pricing for the Acme Pro plan is $29/mo",
        reasoning: "No tool result contains pricing for Acme Pro.",
        citation: "Plans: Free, Team. Contact sales for enterprise.",
      },
      {
        category: "no-tools-called",
        severity: "warn",
        claim: "User has 12 unread emails",
        reasoning: "Agent did not call any inbox tool before claiming this.",
        citation: null,
      },
    ],
    retryGuidance,
  };
}

describe("ValidationPillRow", () => {
  it("running: snapshot", () => {
    const { body } = render(ValidationPillRow, {
      props: { attempt: 1, status: "running" },
    });
    expect(body).toMatchSnapshot();
  });

  it("passed-from-pass: snapshot", () => {
    const { body } = render(ValidationPillRow, {
      props: { attempt: 1, status: "passed", verdict: passVerdict() },
    });
    expect(body).toMatchSnapshot();
  });

  it("passed-from-uncertain: snapshot", () => {
    const { body } = render(ValidationPillRow, {
      props: { attempt: 1, status: "passed", verdict: uncertainVerdict() },
    });
    expect(body).toMatchSnapshot();
  });

  it("failed-retrying: snapshot", () => {
    const { body } = render(ValidationPillRow, {
      props: {
        attempt: 1,
        status: "failed",
        terminal: false,
        verdict: failVerdict(),
      },
    });
    expect(body).toMatchSnapshot();
  });

  it("failed-terminal: snapshot", () => {
    const { body } = render(ValidationPillRow, {
      props: {
        attempt: 2,
        status: "failed",
        terminal: true,
        verdict: failVerdict("No retry guidance — terminal failure."),
      },
    });
    expect(body).toMatchSnapshot();
  });
});
