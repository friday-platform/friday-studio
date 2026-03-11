/**
 * Tests for buildAnalysisPrompt — verifies FQ vs partial name branching
 * and the isFullyQualified segment counting logic.
 */

import { describe, expect, test } from "vitest";

import { buildAnalysisPrompt } from "./prompts.ts";

describe("buildAnalysisPrompt", () => {
  describe("fully qualified names (3+ segments) — no discovery step", () => {
    test.each([
      "DB.SCHEMA.TABLE",
      "MY_DB.PUBLIC.DAILY_FLASH",
      "SNOWFLAKE_LEARNING_DB.PUBLIC.DAILY_FLASH",
    ])("FQ unquoted: %s", (name) => {
      const prompt = buildAnalysisPrompt(name);
      expect(prompt).not.toContain("is not fully qualified");
      expect(prompt).toContain(`Analyze only ${name}`);
      expect(prompt).not.toContain("SHOW SCHEMAS IN DATABASE");
    });

    test.each([
      '"my_db"."my_schema"."my_table"',
      '"DB"."SCHEMA"."TABLE"',
    ])("FQ quoted: %s", (name) => {
      const prompt = buildAnalysisPrompt(name);
      expect(prompt).not.toContain("is not fully qualified");
      expect(prompt).toContain(`Analyze only ${name}`);
    });

    test("mixed quoted and unquoted segments", () => {
      const name = 'DB."my schema".TABLE';
      const prompt = buildAnalysisPrompt(name);
      expect(prompt).not.toContain("is not fully qualified");
      expect(prompt).toContain(`Analyze only ${name}`);
    });
  });

  describe("partial names (<3 segments) — includes discovery step", () => {
    test("single segment (database name)", () => {
      const prompt = buildAnalysisPrompt("SNOWFLAKE_LEARNING_DB");
      expect(prompt).toContain('"SNOWFLAKE_LEARNING_DB" is not fully qualified');
      expect(prompt).toContain("SHOW SCHEMAS IN DATABASE SNOWFLAKE_LEARNING_DB");
      expect(prompt).toContain("After discovering the target table");
      expect(prompt).not.toContain("Analyze only SNOWFLAKE_LEARNING_DB.");
    });

    test("two-part name (DB.SCHEMA)", () => {
      const prompt = buildAnalysisPrompt("DB.SCHEMA");
      expect(prompt).toContain('"DB.SCHEMA" is not fully qualified');
      expect(prompt).toContain("SHOW TABLES IN DB.SCHEMA");
      expect(prompt).toContain("After discovering the target table");
    });

    test("single quoted segment", () => {
      const prompt = buildAnalysisPrompt('"My Database"');
      expect(prompt).toContain("is not fully qualified");
      expect(prompt).toContain("After discovering the target table");
    });
  });

  describe("prompt structure", () => {
    test("always contains table name in preamble", () => {
      const prompt = buildAnalysisPrompt("DB.S.T");
      expect(prompt).toContain("You are analyzing: DB.S.T");
    });

    test("always contains DESCRIBE TABLE step", () => {
      const prompt = buildAnalysisPrompt("DB.S.T");
      expect(prompt).toContain("DESCRIBE TABLE DB.S.T");
    });

    test("always contains SQL RULES section", () => {
      const prompt = buildAnalysisPrompt("X");
      expect(prompt).toContain("SQL RULES:");
      expect(prompt).toContain("Only read-only queries");
    });

    test("always contains save_analysis instruction", () => {
      const prompt = buildAnalysisPrompt("X");
      expect(prompt).toContain("Call save_analysis");
    });
  });
});
