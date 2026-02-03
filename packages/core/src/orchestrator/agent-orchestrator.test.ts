import { fail, success } from "@atlas/utils";
import { describe, expect, it } from "vitest";
import { isStructuredFailure } from "./agent-orchestrator.ts";

describe("isStructuredFailure", () => {
  describe("detects Result<T,E> failures", () => {
    // The actual production bug - ATLAS-18T, ATLAS-1PQ
    it("extracts reason from fail({reason})", () => {
      const output = fail({ reason: "cannot access private artifacts" });

      expect(isStructuredFailure(output)).toBe("cannot access private artifacts");
    });

    it("extracts message when reason not present", () => {
      const output = fail({ message: "error message" });

      expect(isStructuredFailure(output)).toBe("error message");
    });

    it("prefers reason over message when both present", () => {
      const output = fail({ reason: "the reason", message: "the message" });

      expect(isStructuredFailure(output)).toBe("the reason");
    });

    it("extracts string error directly", () => {
      const output = fail("plain string");

      expect(isStructuredFailure(output)).toBe("plain string");
    });

    it("stringifies arbitrary error objects", () => {
      const output = fail({ code: 42, details: "stuff" });

      expect(isStructuredFailure(output)).toContain('"code":42');
      expect(isStructuredFailure(output)).toContain('"details":"stuff"');
    });

    it("returns default message when error field is undefined", () => {
      const output = { ok: false } as const;

      expect(isStructuredFailure(output)).toMatch(/agent returned a failure/i);
    });
  });

  describe("passes through non-failures", () => {
    it("returns undefined for success results", () => {
      expect(isStructuredFailure(success("whatever"))).toBeUndefined();
    });

    it("returns undefined for objects without ok field", () => {
      expect(isStructuredFailure({ foo: "bar" })).toBeUndefined();
    });

    it("returns undefined for primitives and nullish values", () => {
      expect(isStructuredFailure("just a string")).toBeUndefined();
      expect(isStructuredFailure(42)).toBeUndefined();
      expect(isStructuredFailure(null)).toBeUndefined();
      expect(isStructuredFailure(undefined)).toBeUndefined();
    });
  });
});
