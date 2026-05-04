import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";
import type { ArtifactSummary } from "../../artifacts/model.ts";
import type { Chat } from "./../storage.ts";
import { renderChatToHTML } from "./export-html.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
//
// `AtlasUIMessage.parts` is a tagged union from AI SDK v6 that we intentionally
// over-narrow: the renderer only dispatches on `type` and a handful of adjacent
// fields, so we can build test parts as plain records and pass them through
// `as unknown as AtlasUIMessage`. The renderer re-narrows defensively.
// ---------------------------------------------------------------------------

function message(
  role: AtlasUIMessage["role"],
  parts: unknown[],
  id = "msg-1",
): AtlasUIMessage {
  return { id, role, parts } as unknown as AtlasUIMessage;
}

function chat(messages: AtlasUIMessage[]): Chat {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    userId: "user-1",
    workspaceId: "ws-1",
    source: "atlas",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
    messages,
  };
}

function artifact(id: string, title: string, mimeType = "text/plain"): ArtifactSummary {
  return {
    id,
    type: "file",
    revision: 1,
    title,
    summary: `summary for ${title}`,
    createdAt: "2026-05-04T00:00:00.000Z",
    workspaceId: "ws-1",
    chatId: "11111111-2222-3333-4444-555555555555",
    mimeType,
    size: 42,
  };
}

function render(
  messages: AtlasUIMessage[],
  artifacts: ArtifactSummary[] = [],
  pathMap = new Map<string, string>(),
  skipped: ReadonlySet<string> = new Set<string>(),
): string {
  return renderChatToHTML(chat(messages), artifacts, pathMap, skipped);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderChatToHTML", () => {
  describe("user messages", () => {
    it("wraps user text in a role=user message bubble", () => {
      const html = render([
        message("user", [{ type: "text", text: "hello world" }]),
      ]);

      expect(html).toContain('<div class="message" data-role="user">');
      expect(html).toContain('<div class="role">user</div>');
      expect(html).toContain('<div class="content">');
      expect(html).toContain("hello world");
    });

    it("renders the user role label", () => {
      const html = render([
        message("user", [{ type: "text", text: "hello" }]),
      ]);

      expect(html).toMatch(
        /<div class="message" data-role="user"><div class="role">user<\/div>/,
      );
    });
  });

  describe("assistant markdown", () => {
    const md = [
      "Here is some **bold** text and a [link](https://example.com).",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");

    const html = render([message("assistant", [{ type: "text", text: md }])]);

    it("renders bold as <strong>", () => {
      expect(html).toContain("<strong>bold</strong>");
    });

    it("renders links with href", () => {
      expect(html).toContain('href="https://example.com"');
      expect(html).toContain(">link</a>");
    });

    it("renders fenced code blocks as <pre><code>", () => {
      expect(html).toMatch(/<pre><code[^>]*>const x = 1;\s*\n?<\/code><\/pre>/);
    });

    it("does not double-escape markdown HTML output", () => {
      expect(html).not.toContain("&lt;p&gt;");
      expect(html).not.toContain("&lt;strong&gt;");
    });
  });

  describe("tool burst", () => {
    it("renders a single completed tool call as a collapsible <details>", () => {
      const html = render([
        message("assistant", [
          {
            type: "tool-web_fetch",
            toolCallId: "call-1",
            state: "output-available",
            input: { url: "https://example.com" },
            output: { status: 200, body: "ok" },
          },
        ]),
      ]);

      expect(html).toContain('<details class="tool-burst">');
      expect(html).toContain("<summary>");
      expect(html).toContain("web_fetch");
      expect(html).toContain('<div class="tool-call" data-state="output-available">');
      expect(html).toContain('<pre class="tool-input">');
      expect(html).toContain('<pre class="tool-output">');
      // JSON gets HTML-escaped before being placed in <pre>; quotes become &quot;.
      expect(html).toContain("&quot;url&quot;: &quot;https://example.com&quot;");
      expect(html).toContain("&quot;status&quot;: 200");
    });

    it("includes the success status icon in the summary for completed calls", () => {
      const html = render([
        message("assistant", [
          {
            type: "tool-web_fetch",
            toolCallId: "call-1",
            state: "output-available",
            input: { url: "https://x" },
            output: { ok: true },
          },
        ]),
      ]);

      expect(html).toMatch(/<summary>✓ web_fetch<\/summary>/);
    });

    it("renders an errored tool call with tool-error class and error text", () => {
      const html = render([
        message("assistant", [
          {
            type: "tool-web_fetch",
            toolCallId: "call-1",
            state: "output-error",
            input: { url: "https://bad" },
            errorText: "DNS failure",
          },
        ]),
      ]);

      expect(html).toContain('data-state="output-error"');
      expect(html).toContain('<pre class="tool-error">DNS failure</pre>');
      expect(html).toMatch(/<summary>✕ web_fetch<\/summary>/);
    });

    it("escapes HTML metacharacters in tool input and output", () => {
      const html = render([
        message("assistant", [
          {
            type: "tool-run_code",
            toolCallId: "c1",
            state: "output-available",
            input: { code: "<script>" },
            output: "<bad>",
          },
        ]),
      ]);

      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("&lt;bad&gt;");
    });
  });

  describe("system messages", () => {
    it("renders system messages in a system-content element with no .message wrapper", () => {
      const html = render([
        message("system", [{ type: "text", text: "Workspace context: foo" }], "sys-1"),
      ]);

      expect(html).toContain('<div class="system-content">');
      expect(html).toContain("Workspace context: foo");
      // The CSS in <style> mentions data-role="system" as a selector — only
      // assert against the document <body>, not the stylesheet.
      const body = html.split("</style>")[1] ?? "";
      expect(body).not.toContain('data-role="system"');
      expect(body).not.toContain('class="message"');
    });

    it("renders system content through markdown so emphasis still works", () => {
      const html = render([
        message("system", [{ type: "text", text: "**important** notice" }], "sys-1"),
      ]);

      expect(html).toContain('<div class="system-content">');
      expect(html).toContain("<strong>important</strong>");
    });
  });

  describe("inline images", () => {
    it("renders a data-URL file part as <img class=message-image>", () => {
      const dataUrl =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/AAAZ4gk3AAAACklEQVR4AWNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==";
      const html = render([
        message("user", [
          { type: "text", text: "see screenshot" },
          { type: "file", url: dataUrl, mediaType: "image/png", filename: "screen.png" },
        ]),
      ]);

      expect(html).toContain(`<img src="${dataUrl}"`);
      expect(html).toContain('class="message-image"');
      expect(html).toContain('alt="screen.png"');
      expect(html).toContain('<div class="message-images">');
    });
  });

  describe("artifacts", () => {
    it("renders a trailing Artifacts section with download links for bundled artifacts", () => {
      const a = artifact("art-1", "Report.txt");
      const b = artifact("art-2", "data.csv", "text/csv");
      const pathMap = new Map<string, string>([
        ["art-1", "assets/artifacts/art-1/Report.txt"],
        ["art-2", "assets/artifacts/art-2/data.csv"],
      ]);
      const html = render(
        [message("assistant", [{ type: "text", text: "done" }])],
        [a, b],
        pathMap,
      );

      expect(html).toContain('<section class="artifacts">');
      expect(html).toContain("<h2>Artifacts</h2>");
      expect(html).toContain('href="assets/artifacts/art-1/Report.txt"');
      expect(html).toContain('href="assets/artifacts/art-2/data.csv"');
      expect(html).toMatch(/Report\.txt[^<]*<\/span>\s*<a class="artifact-download"/);
    });

    it("renders an artifact-skipped placeholder when the id is in skippedArtifactIds", () => {
      const a = artifact("art-skip", "huge-blob.bin", "application/octet-stream");
      const html = render(
        [message("assistant", [{ type: "text", text: "done" }])],
        [a],
        new Map(),
        new Set(["art-skip"]),
      );

      expect(html).toContain('<span class="artifact-skipped">');
      expect(html).toContain("[skipped: artifact too large for export]");
      expect(html).not.toContain('class="artifact-unavailable"');
      expect(html).not.toContain('class="artifact-download"');
    });

    it("renders an artifact-unavailable placeholder for failed reads (distinct from skipped)", () => {
      const a = artifact("art-fail", "broken.txt");
      const html = render(
        [message("assistant", [{ type: "text", text: "done" }])],
        [a],
        new Map(),
        new Set(),
      );

      expect(html).toContain('<span class="artifact-unavailable">');
      expect(html).toContain("[artifact file unavailable]");
      expect(html).not.toContain('class="artifact-skipped">');
      expect(html).not.toContain('class="artifact-download"');
    });

    it("attributes a display_artifact tool call inline and omits it from the trailing list", () => {
      const a = artifact("art-1", "shown.txt");
      const b = artifact("art-2", "leftover.txt");
      const pathMap = new Map<string, string>([
        ["art-1", "assets/artifacts/art-1/shown.txt"],
        ["art-2", "assets/artifacts/art-2/leftover.txt"],
      ]);
      const html = render(
        [
          message("assistant", [
            {
              type: "tool-display_artifact",
              toolCallId: "call-1",
              state: "output-available",
              input: { artifactId: "art-1" },
              output: { success: true, artifactId: "art-1" },
            },
          ]),
        ],
        [a, b],
        pathMap,
      );

      // Inline reference inside the tool-call body.
      expect(html).toMatch(
        /<div class="tool-call"[\s\S]*shown\.txt[\s\S]*assets\/artifacts\/art-1\/shown\.txt/,
      );
      // Trailing list contains art-2 but not art-1 (already attributed).
      const artifactsSection = html.split('<section class="artifacts">')[1] ?? "";
      expect(artifactsSection).toContain("leftover.txt");
      expect(artifactsSection).not.toContain("shown.txt");
    });
  });

  describe("document shape", () => {
    it("emits a complete HTML document with inline styles and the chat title prefix", () => {
      const html = render([message("user", [{ type: "text", text: "hi" }])]);

      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain('<html lang="en">');
      expect(html).toContain("<title>Chat 11111111</title>");
      expect(html).toContain("<style>");
      expect(html).toContain("color-scheme: light dark;");
      expect(html.trimEnd().endsWith("</html>")).toBe(true);
    });
  });
});
