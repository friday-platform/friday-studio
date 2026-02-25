import { describe, expect, it } from "vitest";
import { parseSkillMd } from "../src/skill-md-parser.ts";

describe("parseSkillMd", () => {
  it("parses valid frontmatter and instructions", () => {
    const content = `---
name: code-review
description: Reviews code for correctness and style
---

Review the code for:
1. Correctness issues
2. Style violations`;

    const result = parseSkillMd(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.frontmatter.name).toBe("code-review");
    expect(result.data.frontmatter.description).toBe("Reviews code for correctness and style");
    expect(result.data.instructions).toBe(
      "Review the code for:\n1. Correctness issues\n2. Style violations",
    );
  });

  it("parses all known frontmatter fields", () => {
    const content = `---
name: code-review
description: Reviews code
allowed-tools: Read, Grep, Glob
context: fork
agent: Explore
model: claude-sonnet-4-5-20250514
disable-model-invocation: true
user-invocable: false
argument-hint: "[filename]"
---

Instructions here.`;

    const result = parseSkillMd(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fm = result.data.frontmatter;
    expect(fm.name).toBe("code-review");
    expect(fm.description).toBe("Reviews code");
    expect(fm["allowed-tools"]).toBe("Read, Grep, Glob");
    expect(fm.context).toBe("fork");
    expect(fm.agent).toBe("Explore");
    expect(fm.model).toBe("claude-sonnet-4-5-20250514");
    expect(fm["disable-model-invocation"]).toBe(true);
    expect(fm["user-invocable"]).toBe(false);
    expect(fm["argument-hint"]).toBe("[filename]");
  });

  it("returns empty frontmatter when no delimiters present", () => {
    const content = "Just plain instructions\nwith no frontmatter.";

    const result = parseSkillMd(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.frontmatter).toEqual({});
    expect(result.data.instructions).toBe("Just plain instructions\nwith no frontmatter.");
  });

  it("handles empty frontmatter block", () => {
    const content = `---
---

Instructions after empty frontmatter.`;

    const result = parseSkillMd(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.frontmatter).toEqual({});
    expect(result.data.instructions).toBe("Instructions after empty frontmatter.");
  });

  it("returns error for malformed YAML", () => {
    const content = `---
name: [invalid yaml
  broken: {
---

Instructions.`;

    const result = parseSkillMd(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("frontmatter");
  });

  it("preserves unknown frontmatter keys", () => {
    const content = `---
name: my-skill
description: Preserves unknown keys
custom-field: hello
another: 42
---

Body.`;

    const result = parseSkillMd(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.frontmatter.name).toBe("my-skill");
    expect(result.data.frontmatter["custom-field"]).toBe("hello");
    expect(result.data.frontmatter.another).toBe(42);
  });

  it("handles extra --- in the instructions body", () => {
    const content = `---
name: my-skill
description: Handles extra delimiters
---

Some instructions.

---

This is a horizontal rule, not a delimiter.

---

More content.`;

    const result = parseSkillMd(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.frontmatter.name).toBe("my-skill");
    expect(result.data.instructions).toContain("This is a horizontal rule");
    expect(result.data.instructions).toContain("More content.");
  });

  it("trims leading and trailing whitespace from instructions", () => {
    const content = `---
name: my-skill
description: Trims whitespace
---


  Instructions with surrounding whitespace.

`;

    const result = parseSkillMd(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.instructions).toBe("Instructions with surrounding whitespace.");
  });

  it("handles content that starts with --- but has no closing ---", () => {
    const content = `---
name: orphan-frontmatter
This never closes`;

    const result = parseSkillMd(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No closing delimiter means no frontmatter — treat entire content as instructions
    expect(result.data.frontmatter).toEqual({});
    expect(result.data.instructions).toBe(content);
  });

  it("handles empty content", () => {
    const result = parseSkillMd("");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.frontmatter).toEqual({});
    expect(result.data.instructions).toBe("");
  });

  it("validates frontmatter field types", () => {
    const content = `---
name: 123
description: Valid description
---

Body.`;

    const result = parseSkillMd(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("frontmatter");
  });

  it("rejects missing description in frontmatter", () => {
    const content = `---
name: my-skill
---

Body.`;

    const result = parseSkillMd(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("frontmatter");
  });

  it("rejects description exceeding 1024 characters", () => {
    const longDesc = "a".repeat(1025);
    const content = `---
name: my-skill
description: ${longDesc}
---

Body.`;

    const result = parseSkillMd(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("frontmatter");
  });

  it("rejects XML tags in description", () => {
    const content = `---
name: my-skill
description: Injects <script>alert('xss')</script> tags
---

Body.`;

    const result = parseSkillMd(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("XML");
  });
});
