import { describe, expect, it } from "vitest";
import { SupervisionLevel } from "./supervision-levels.ts";
import {
  getThresholdForLevel,
  judgeErrorVerdict,
  severityForCategory,
  statusFromConfidence,
} from "./verdict.ts";

describe("getThresholdForLevel", () => {
  it("returns 0.35 for MINIMAL", () => {
    expect(getThresholdForLevel(SupervisionLevel.MINIMAL)).toBe(0.35);
  });
  it("returns 0.45 for STANDARD", () => {
    expect(getThresholdForLevel(SupervisionLevel.STANDARD)).toBe(0.45);
  });
  it("returns 0.6 for PARANOID", () => {
    expect(getThresholdForLevel(SupervisionLevel.PARANOID)).toBe(0.6);
  });
});

describe("statusFromConfidence", () => {
  describe("MINIMAL (threshold 0.35)", () => {
    const t = getThresholdForLevel(SupervisionLevel.MINIMAL);
    it("0.5 → pass (above threshold)", () => {
      expect(statusFromConfidence(0.5, t)).toBe("pass");
    });
    it("0.32 → uncertain (between fail-floor and threshold)", () => {
      expect(statusFromConfidence(0.32, t)).toBe("uncertain");
    });
    it("0.2 → fail (below fail-floor)", () => {
      expect(statusFromConfidence(0.2, t)).toBe("fail");
    });
  });

  describe("STANDARD (threshold 0.45)", () => {
    const t = getThresholdForLevel(SupervisionLevel.STANDARD);
    it("0.6 → pass", () => {
      expect(statusFromConfidence(0.6, t)).toBe("pass");
    });
    it("0.4 → uncertain", () => {
      expect(statusFromConfidence(0.4, t)).toBe("uncertain");
    });
    it("0.25 → fail", () => {
      expect(statusFromConfidence(0.25, t)).toBe("fail");
    });
  });

  describe("PARANOID (threshold 0.6)", () => {
    const t = getThresholdForLevel(SupervisionLevel.PARANOID);
    it("0.7 → pass", () => {
      expect(statusFromConfidence(0.7, t)).toBe("pass");
    });
    it("0.5 → uncertain (below paranoid threshold but above fail-floor)", () => {
      expect(statusFromConfidence(0.5, t)).toBe("uncertain");
    });
    it("0.1 → fail", () => {
      expect(statusFromConfidence(0.1, t)).toBe("fail");
    });
  });

  describe("boundary conditions", () => {
    it("exact threshold value → pass (>= is inclusive)", () => {
      expect(statusFromConfidence(0.45, 0.45)).toBe("pass");
    });
    it("exact 0.3 fail-floor → uncertain (>= is inclusive)", () => {
      expect(statusFromConfidence(0.3, 0.45)).toBe("uncertain");
    });
    it("just below fail-floor (0.299) → fail", () => {
      expect(statusFromConfidence(0.299, 0.45)).toBe("fail");
    });
  });
});

describe("severityForCategory", () => {
  it("sourcing → error", () => {
    expect(severityForCategory("sourcing")).toBe("error");
  });
  it("no-tools-called → warn", () => {
    expect(severityForCategory("no-tools-called")).toBe("warn");
  });
  it("judge-uncertain → info", () => {
    expect(severityForCategory("judge-uncertain")).toBe("info");
  });
  it("judge-error → info", () => {
    expect(severityForCategory("judge-error")).toBe("info");
  });
});

describe("judgeErrorVerdict", () => {
  it("returns uncertain status with confidence 0.4", () => {
    const verdict = judgeErrorVerdict(0.45, "boom");
    expect(verdict.status).toBe("uncertain");
    expect(verdict.confidence).toBe(0.4);
  });

  it("preserves the supplied threshold", () => {
    const verdict = judgeErrorVerdict(0.6, "boom");
    expect(verdict.threshold).toBe(0.6);
  });

  it("emits a single judge-error issue with null citation", () => {
    const verdict = judgeErrorVerdict(0.45, "rate limited");
    expect(verdict.issues).toHaveLength(1);
    const [issue] = verdict.issues;
    expect(issue).toBeDefined();
    if (!issue) return;
    expect(issue.category).toBe("judge-error");
    expect(issue.severity).toBe("info");
    expect(issue.citation).toBeNull();
    expect(issue.reasoning).toBe("rate limited");
  });

  it("retryGuidance is empty (judge-error is not actionable)", () => {
    const verdict = judgeErrorVerdict(0.45, "boom");
    expect(verdict.retryGuidance).toBe("");
  });
});
