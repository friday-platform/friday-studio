import { describe, expect, it } from "vitest";
import { resolveArtifactRefs, stripArtifactIdPrefix } from "./resolve-artifact-refs.ts";

const artifact1 = { id: "aaa-111", filename: "data.csv" };
const artifact2 = { id: "bbb-222", filename: "report.pdf" };

describe("resolveArtifactRefs", () => {
  describe("single artifact-ref field", () => {
    const schema = {
      type: "object",
      properties: { file_path: { type: "string", format: "artifact-ref" } },
      required: ["file_path"],
    };

    it("passes through a correct artifact ID unchanged", () => {
      const result = resolveArtifactRefs(schema, { file_path: "aaa-111" }, [artifact1]);
      expect(result).toEqual({ success: true, payload: { file_path: "aaa-111" } });
    });

    it("rejects a hallucinated artifact ID with valid options", () => {
      const result = resolveArtifactRefs(schema, { file_path: "bad-id" }, [artifact1, artifact2]);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("bad-id");
        expect(result.error).toContain("aaa-111");
        expect(result.error).toContain("bbb-222");
      }
    });

    it("auto-fills when omitted with exactly one artifact", () => {
      const result = resolveArtifactRefs(schema, {}, [artifact1]);
      expect(result).toEqual({ success: true, payload: { file_path: "aaa-111" } });
    });

    it("errors when omitted with zero artifacts", () => {
      const result = resolveArtifactRefs(schema, {}, []);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("no artifacts");
      }
    });

    it("errors when omitted with multiple artifacts (ambiguous)", () => {
      const result = resolveArtifactRefs(schema, {}, [artifact1, artifact2]);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("aaa-111");
        expect(result.error).toContain("bbb-222");
      }
    });

    it("leaves omitted optional field alone", () => {
      const optionalSchema = {
        type: "object",
        properties: { file_path: { type: "string", format: "artifact-ref" } },
        // no required
      };
      const result = resolveArtifactRefs(optionalSchema, {}, [artifact1]);
      expect(result).toEqual({ success: true, payload: {} });
    });
  });

  describe("array artifact-ref field", () => {
    const requiredSchema = {
      type: "object",
      properties: { files: { type: "array", items: { type: "string", format: "artifact-ref" } } },
      required: ["files"],
    };

    const optionalSchema = {
      type: "object",
      properties: { files: { type: "array", items: { type: "string", format: "artifact-ref" } } },
    };

    it("auto-fills omitted required array field with all artifact IDs", () => {
      const result = resolveArtifactRefs(requiredSchema, {}, [artifact1, artifact2]);
      expect(result).toEqual({ success: true, payload: { files: ["aaa-111", "bbb-222"] } });
    });

    it("errors when omitted required array field with zero artifacts", () => {
      const result = resolveArtifactRefs(requiredSchema, {}, []);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("no artifacts");
      }
    });

    it("leaves omitted optional array field alone", () => {
      const result = resolveArtifactRefs(optionalSchema, {}, [artifact1, artifact2]);
      expect(result).toEqual({ success: true, payload: {} });
    });

    it("passes through valid array of artifact IDs", () => {
      const result = resolveArtifactRefs(optionalSchema, { files: ["aaa-111", "bbb-222"] }, [
        artifact1,
        artifact2,
      ]);
      expect(result).toEqual({ success: true, payload: { files: ["aaa-111", "bbb-222"] } });
    });

    it("rejects array containing an invalid artifact ID", () => {
      const result = resolveArtifactRefs(optionalSchema, { files: ["aaa-111", "bad-id"] }, [
        artifact1,
      ]);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("bad-id");
      }
    });
  });

  describe("no artifact-ref fields", () => {
    it("returns payload unchanged when schema has no artifact-ref fields", () => {
      const schema = { type: "object", properties: { name: { type: "string" } } };
      const payload = { name: "test" };
      const result = resolveArtifactRefs(schema, payload, [artifact1]);
      expect(result).toEqual({ success: true, payload: { name: "test" } });
    });

    it("returns payload unchanged when schema has no properties", () => {
      const result = resolveArtifactRefs({ type: "object" }, { foo: "bar" }, [artifact1]);
      expect(result).toEqual({ success: true, payload: { foo: "bar" } });
    });
  });

  describe("prefix stripping", () => {
    const schema = {
      type: "object",
      properties: { file_path: { type: "string", format: "artifact-ref" } },
      required: ["file_path"],
    };

    it("strips 'artifact:' prefix and resolves to bare ID", () => {
      const result = resolveArtifactRefs(schema, { file_path: "artifact:aaa-111" }, [artifact1]);
      expect(result).toEqual({ success: true, payload: { file_path: "aaa-111" } });
    });

    it("strips 'cortex://' prefix and resolves to bare ID", () => {
      const result = resolveArtifactRefs(schema, { file_path: "cortex://aaa-111" }, [artifact1]);
      expect(result).toEqual({ success: true, payload: { file_path: "aaa-111" } });
    });

    it("strips prefixes in array fields", () => {
      const arraySchema = {
        type: "object",
        properties: { files: { type: "array", items: { type: "string", format: "artifact-ref" } } },
      };
      const result = resolveArtifactRefs(
        arraySchema,
        { files: ["artifact:aaa-111", "cortex://bbb-222"] },
        [artifact1, artifact2],
      );
      expect(result).toEqual({ success: true, payload: { files: ["aaa-111", "bbb-222"] } });
    });

    it("still rejects invalid ID after prefix stripping", () => {
      const result = resolveArtifactRefs(schema, { file_path: "artifact:bad-id" }, [artifact1]);
      expect(result.success).toBe(false);
    });
  });

  describe("stripArtifactIdPrefix", () => {
    it("strips artifact: prefix", () => {
      expect(stripArtifactIdPrefix("artifact:abc-123")).toBe("abc-123");
    });

    it("strips cortex:// prefix", () => {
      expect(stripArtifactIdPrefix("cortex://abc-123")).toBe("abc-123");
    });

    it("leaves bare UUIDs unchanged", () => {
      expect(stripArtifactIdPrefix("abc-123")).toBe("abc-123");
    });

    it("leaves unknown prefixes unchanged", () => {
      expect(stripArtifactIdPrefix("file://abc-123")).toBe("file://abc-123");
    });
  });

  describe("nested artifact-ref fields (not resolved)", () => {
    it("does not resolve artifact-ref inside nested object properties", () => {
      const schema = {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: { file_path: { type: "string", format: "artifact-ref" } },
          },
        },
      };
      // Nested artifact-ref should be ignored -- no resolution, no error
      const result = resolveArtifactRefs(schema, { config: { file_path: "whatever" } }, []);
      expect(result).toEqual({ success: true, payload: { config: { file_path: "whatever" } } });
    });
  });
});
