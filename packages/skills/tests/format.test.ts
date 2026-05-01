import { describe, expect, it } from "vitest";
import { formatAvailableSkills } from "../src/format.ts";

describe("formatAvailableSkills", () => {
  it("returns empty string for empty array", () => {
    expect(formatAvailableSkills([])).toBe("");
  });

  it("formats single skill", () => {
    const result = formatAvailableSkills([{ name: "my-skill", description: "Does things" }]);
    expect(result.includes("<available_skills>")).toBe(true);
    expect(result.includes('<skill name="my-skill">Does things</skill>')).toBe(true);
    expect(result.includes("</available_skills>")).toBe(true);
  });

  it("formats multiple skills", () => {
    const result = formatAvailableSkills([
      { name: "skill-a", description: "A" },
      { name: "skill-b", description: "B" },
    ]);
    expect(result.includes('<skill name="skill-a">A</skill>')).toBe(true);
    expect(result.includes('<skill name="skill-b">B</skill>')).toBe(true);
  });
});
