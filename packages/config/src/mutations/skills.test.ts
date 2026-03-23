/**
 * Tests for skill mutation functions
 */

import { describe, expect, test } from "vitest";
import { addSkill, removeSkill } from "./skills.ts";
import { createTestConfig, expectError } from "./test-fixtures.ts";

describe("removeSkill", () => {
  test("removes a catalog skill by ref name", () => {
    const config = createTestConfig({
      skills: [{ name: "@test/skill-one" }, { name: "@test/skill-two" }],
    });

    const result = removeSkill(config, "@test/skill-one");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills).toHaveLength(1);
      expect(result.value.skills?.[0]?.name).toBe("@test/skill-two");
    }
  });

  test("removes an inline skill by name", () => {
    const config = createTestConfig({
      skills: [
        { name: "my-inline", inline: true, description: "A skill", instructions: "Do stuff" },
      ],
    });

    const result = removeSkill(config, "my-inline");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills).toBeUndefined();
    }
  });

  test("returns not_found when skill does not exist", () => {
    const config = createTestConfig({ skills: [{ name: "@test/existing" }] });

    const result = removeSkill(config, "@test/nonexistent");

    expectError(result, "not_found");
  });

  test("returns not_found when skills array is empty", () => {
    const config = createTestConfig();

    const result = removeSkill(config, "@test/anything");

    expectError(result, "not_found");
  });

  test("deletes skills key when last skill is removed", () => {
    const config = createTestConfig({ skills: [{ name: "@test/only-one" }] });

    const result = removeSkill(config, "@test/only-one");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills).toBeUndefined();
    }
  });

  test("does not mutate the original config", () => {
    const config = createTestConfig({
      skills: [{ name: "@test/skill-one" }, { name: "@test/skill-two" }],
    });

    removeSkill(config, "@test/skill-one");

    expect(config.skills).toHaveLength(2);
  });
});

describe("addSkill", () => {
  test("adds a catalog skill ref to empty skills", () => {
    const config = createTestConfig();

    const result = addSkill(config, "@test/new-skill");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills).toHaveLength(1);
      expect(result.value.skills?.[0]?.name).toBe("@test/new-skill");
    }
  });

  test("appends to existing skills array", () => {
    const config = createTestConfig({ skills: [{ name: "@test/existing" }] });

    const result = addSkill(config, "@test/another");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills).toHaveLength(2);
      expect(result.value.skills?.[1]?.name).toBe("@test/another");
    }
  });

  test("returns conflict when skill is already bound", () => {
    const config = createTestConfig({ skills: [{ name: "@test/existing" }] });

    const result = addSkill(config, "@test/existing");

    expectError(result, "conflict");
  });

  test("returns validation error for invalid skill ref", () => {
    const config = createTestConfig();

    const result = addSkill(config, "not-a-valid-ref");

    expectError(result, "validation");
  });

  test("does not mutate the original config", () => {
    const config = createTestConfig();

    addSkill(config, "@test/new-skill");

    expect(config.skills).toBeUndefined();
  });
});
