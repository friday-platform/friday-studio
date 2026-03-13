import { describe, expect, it } from "vitest";
import { buildEmailBody, composeEmailSchema, renderContentBlocks } from "./communicator.ts";
import { escapeHtml, sanitizeHref } from "./sanitize.ts";

// ---------------------------------------------------------------------------
// Security constraint: LLM tool schema must not accept sender fields (TEM-3856)
// ---------------------------------------------------------------------------

describe("composeEmailSchema - sender field rejection", () => {
  it("does not define 'from' or 'from_name' fields", () => {
    const fields = Object.keys(composeEmailSchema.shape);
    expect(fields).not.toContain("from");
    expect(fields).not.toContain("from_name");
  });
});

// ---------------------------------------------------------------------------
// HTML sanitization
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("escapes all HTML special characters", () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
  });

  it("escapes ampersands and single quotes", () => {
    expect(escapeHtml("A & B's")).toBe("A &amp; B&#039;s");
  });
});

describe("sanitizeHref", () => {
  it("allows https URLs", () => {
    expect(sanitizeHref("https://example.com/path")).toBe("https://example.com/path");
  });

  it("allows http URLs", () => {
    expect(sanitizeHref("http://example.com")).toBe("http://example.com");
  });

  it("rejects javascript: URLs", () => {
    expect(sanitizeHref("javascript:alert(1)")).toBe("");
  });

  it("rejects case-variant javascript: URLs", () => {
    expect(sanitizeHref("JAVASCRIPT:alert(1)")).toBe("");
    expect(sanitizeHref("jAvAsCrIpT:alert(1)")).toBe("");
  });

  it("rejects data: URLs", () => {
    expect(sanitizeHref("data:text/html,<h1>XSS</h1>")).toBe("");
  });

  it("rejects relative URLs", () => {
    expect(sanitizeHref("/etc/passwd")).toBe("");
  });

  it("escapes HTML in valid URLs", () => {
    expect(sanitizeHref('https://example.com/q="test"')).toBe(
      "https://example.com/q=&quot;test&quot;",
    );
  });
});

// ---------------------------------------------------------------------------
// Email body building: verifies the full rendering + template pipeline
// ---------------------------------------------------------------------------

describe("buildEmailBody", () => {
  const tpl = "BEFORE{{ content }}MIDDLE{{ sender_info }}AFTER";
  const sender = "<p>Sent by test@example.com</p>";

  it("replaces both placeholders in a single pass", () => {
    const html = buildEmailBody(tpl, [{ tag: "paragraph", content: "Hello" }], sender);
    expect(html).toContain("BEFORE<p ");
    expect(html).toContain("MIDDLE<p>Sent by");
    expect(html).toContain("AFTER");
    expect(html).not.toContain("{{ content }}");
    expect(html).not.toContain("{{ sender_info }}");
  });

  it("LLM content containing {{ sender_info }} is not replaced", () => {
    const html = buildEmailBody(tpl, [{ tag: "paragraph", content: "{{ sender_info }}" }], sender);
    // The literal "{{ sender_info }}" in content should survive as escaped text,
    // NOT be substituted with sender HTML — single-pass prevents this
    const contentSection = html.split("MIDDLE")[0];
    expect(contentSection).toContain("{{ sender_info }}");
    // The actual sender_info replacement should happen exactly once (in MIDDLE)
    const senderOccurrences = html.split(sender).length - 1;
    expect(senderOccurrences).toBe(1);
  });

  it("escapes XSS payloads in content blocks", () => {
    const html = buildEmailBody(
      tpl,
      [{ tag: "paragraph", content: '<script>alert("xss")</script>' }],
      sender,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("sanitizes link hrefs and falls back to span for rejected URLs", () => {
    const html = buildEmailBody(tpl, [{ tag: "link", content: "javascript:alert(1)" }], sender);
    expect(html).not.toContain("href");
    expect(html).toContain("<span>");
  });
});

// ---------------------------------------------------------------------------
// Content block rendering
// ---------------------------------------------------------------------------

describe("renderContentBlocks", () => {
  it("escapes HTML in paragraph content", () => {
    const html = renderContentBlocks([
      { tag: "paragraph", content: '<img src=x onerror="alert(1)">' },
    ]);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toMatch(/^<p /);
  });

  it("escapes HTML in heading content", () => {
    const html = renderContentBlocks([{ tag: "heading", content: "<script>xss</script>" }]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toMatch(/^<h2 /);
  });

  it("sanitizes javascript: href and falls back to span", () => {
    const html = renderContentBlocks([
      { tag: "link", content: "javascript:alert(document.cookie)" },
    ]);
    expect(html).not.toContain("href");
    expect(html).toMatch(/^<span>/);
  });

  it("escapes HTML in rejected link content", () => {
    const html = renderContentBlocks([
      { tag: "link", content: 'javascript:"><img src=x onerror=alert(1)>' },
    ]);
    expect(html).toMatch(/^<span>/);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });

  it("renders valid link with escaped href", () => {
    const html = renderContentBlocks([{ tag: "link", content: 'https://example.com/q="test"' }]);
    expect(html).toContain('href="https://example.com/q=&quot;test&quot;"');
    expect(html).toMatch(/^<a /);
  });

  it("escapes HTML for unknown tag types", () => {
    const html = renderContentBlocks([{ tag: "unknown", content: "<b>bold</b>" }]);
    expect(html).toBe("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("joins multiple blocks without separator", () => {
    const html = renderContentBlocks([
      { tag: "heading", content: "Title" },
      { tag: "paragraph", content: "Body" },
    ]);
    expect(html).toMatch(/<\/h2><p /);
  });
});
