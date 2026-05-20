/**
 * `shouldBindHealthListener` is the equal-port short-circuit guard
 * relied on by the launcher's `--health-port == --port` disable path
 * (currently the only way to single-listener mode in production). The
 * 65500 cap on FRIDAY_PORT_FRIDAY guarantees `<port>+1` is bindable,
 * so the only case the guard exists to handle is deliberate disable.
 *
 * Tests cover the three meaningful branches:
 *   - undefined / non-positive healthPort → skip (no listener)
 *   - healthPort === port → skip (deliberate disable)
 *   - healthPort > 0 AND !== port → bind
 */
import { describe, expect, it } from "vitest";
import { shouldBindHealthListener } from "./health-listener-policy.ts";

describe("shouldBindHealthListener", () => {
  describe("returns false (skip)", () => {
    it("undefined healthPort", () => {
      expect(shouldBindHealthListener(8080, undefined)).toBe(false);
    });

    it("zero healthPort", () => {
      expect(shouldBindHealthListener(8080, 0)).toBe(false);
    });

    it("negative healthPort", () => {
      expect(shouldBindHealthListener(8080, -1)).toBe(false);
    });

    it("healthPort === port (deliberate disable via --health-port=--port)", () => {
      expect(shouldBindHealthListener(8080, 8080)).toBe(false);
    });

    it("both undefined (single-listener mode)", () => {
      expect(shouldBindHealthListener(undefined, undefined)).toBe(false);
    });
  });

  describe("returns true (bind)", () => {
    it("typical default: healthPort = port + 1", () => {
      expect(shouldBindHealthListener(8080, 8081)).toBe(true);
    });

    it("override case: healthPort = main + 1 after FRIDAY_PORT_FRIDAY override", () => {
      expect(shouldBindHealthListener(18080, 18081)).toBe(true);
    });

    it("unusual but valid: healthPort far from port", () => {
      expect(shouldBindHealthListener(8080, 9999)).toBe(true);
    });

    it("healthPort = 1 (low end of valid)", () => {
      expect(shouldBindHealthListener(8080, 1)).toBe(true);
    });

    it("port undefined, healthPort set (atypical but defined behavior)", () => {
      // If `port` is undefined the equal-port comparison is false,
      // so we'd still bind. This is unreachable from the production
      // CLI path (port always defaults to 8080), but the helper
      // shouldn't crash on undefined.
      expect(shouldBindHealthListener(undefined, 9999)).toBe(true);
    });
  });
});
