import { describe, expect, test } from "vitest";
import { KnowledgeOutputSchema } from "./shared.ts";

describe("KnowledgeOutputSchema", () => {
  test("parses valid output", () => {
    const valid = {
      response: "Here is the answer.",
      sources: [
        {
          sectionTitle: "FAQ",
          chapter: "knowledge_base",
          lineStart: 1,
          lineEnd: 10,
          sourceFile: "https://example.com/faq",
        },
      ],
    };
    const result = KnowledgeOutputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test("requires response field", () => {
    const invalid = { sources: [] };
    const result = KnowledgeOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test("requires sources field", () => {
    const invalid = { response: "answer" };
    const result = KnowledgeOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test("accepts empty sources array", () => {
    const valid = { response: "No results found.", sources: [] };
    const result = KnowledgeOutputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test("validates source object shape", () => {
    const invalid = {
      response: "answer",
      sources: [{ sectionTitle: "FAQ" }], // missing required fields
    };
    const result = KnowledgeOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});
