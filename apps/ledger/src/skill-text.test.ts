import { describe, expect, test } from "vitest";
import { buildSqliteSkillText, SQLITE_SKILL_TEXT } from "./sqlite-skill.ts";

const engines = [
  {
    name: "sqlite",
    build: buildSqliteSkillText,
    fullText: SQLITE_SKILL_TEXT,
    aggFn: "json_group_array()",
  },
];

describe.each(engines)("$name skill text", ({ build, fullText, aggFn }) => {
  test("undefined returns full text", () => {
    expect(build()).toBe(fullText);
  });

  test("empty array returns same as undefined", () => {
    expect(build([])).toBe(fullText);
  });

  test("all four tools matches full text", () => {
    expect(build(["resource_read", "resource_write", "resource_save", "resource_link_ref"])).toBe(
      fullText,
    );
  });

  test("critical rules use bullet points, not numbered list", () => {
    const text = build();
    expect.soft(text).toContain("## Critical Rules");
    expect.soft(text).toContain("- **resource_write must return exactly one value**");
    expect.soft(text).toContain(`- **${aggFn}**`);
    expect.soft(text).not.toMatch(/^\d+\.\s\*\*/m);
  });

  // -------------------------------------------------------------------------
  // Tool filtering
  // -------------------------------------------------------------------------

  const filterCases = [
    {
      name: "single tool filters to just that tool",
      tools: ["resource_read"],
      contains: ["One tool:", "resource_read(slug, query, params?)"],
      excludes: [
        "resource_write(slug, query, params?)",
        "resource_save(slug)",
        "resource_link_ref(slug, ref)",
      ],
    },
    {
      name: "two tools renders 'Two tools:'",
      tools: ["resource_read", "resource_save"],
      contains: ["Two tools:", "resource_read", "resource_save"],
      excludes: ["resource_write(slug"],
    },
  ];

  test.each(filterCases)("$name", ({ tools, contains, excludes }) => {
    const text = build(tools);
    for (const s of contains) expect.soft(text).toContain(s);
    for (const s of excludes) expect.soft(text).not.toContain(s);
  });

  // -------------------------------------------------------------------------
  // Read-only filtering
  // -------------------------------------------------------------------------

  test("read-only tool excludes writing patterns", () => {
    const text = build(["resource_read"]);
    expect.soft(text).toContain("## Reading Patterns");
    expect.soft(text).not.toContain("## Writing Patterns");
  });

  test("read-only tool excludes write-specific critical rules", () => {
    const text = build(["resource_read"]);
    expect.soft(text).not.toContain("resource_write must return exactly one value");
    expect.soft(text).not.toContain("artifact_ref and external_ref");
    expect.soft(text).toContain(aggFn);
    expect.soft(text).toContain("$1, $2... params");
  });

  // -------------------------------------------------------------------------
  // Critical rule inclusion by tool combination
  // -------------------------------------------------------------------------

  test("resource_write + resource_link_ref includes all critical rules", () => {
    const text = build(["resource_write", "resource_link_ref"]);
    expect.soft(text).toContain("resource_write must return exactly one value");
    expect.soft(text).toContain("artifact_ref and external_ref");
    expect.soft(text).toContain(aggFn);
  });

  test("resource_link_ref alone excludes artifact_ref rule (needs both write + link_ref)", () => {
    const text = build(["resource_link_ref"]);
    expect.soft(text).not.toContain("artifact_ref and external_ref");
    expect.soft(text).not.toContain("resource_write must return exactly one value");
  });

  test("both resource_write and resource_link_ref includes artifact_ref rule", () => {
    const text = build(["resource_write", "resource_link_ref"]);
    expect.soft(text).toContain("artifact_ref and external_ref");
    expect.soft(text).toContain("resource_write must return exactly one value");
  });
});
