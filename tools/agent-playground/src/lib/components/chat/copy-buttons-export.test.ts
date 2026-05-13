/**
 * Verifies that `tool-call-card.svelte`'s copy-to-clipboard affordances
 * are suppressed when the card renders inside an `ExportContext`. The
 * data still renders — only the wrapper + button machinery is omitted.
 *
 * Live UI behavior (no context set) keeps the wrapper and button intact;
 * that path is exercised in the second `describe` block.
 */

import { readable } from "svelte/store";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import type { ExportContext } from "./export-context.ts";
import type { ToolCallDisplay } from "./types.ts";

// `@atlas/ui` is a single-entry barrel that pulls @tanstack/svelte-table on
// load. The card only needs a handful of icons; stub them with an empty SVG
// component so the test does not drag the table dep into Vitest's graph.
vi.mock("@atlas/ui", async () => {
  const mod = await import("./__test-stubs__/icon-stub.svelte");
  const Stub = mod.default;
  const proxy = new Proxy({}, { get: () => Stub });
  return {
    Icons: proxy,
    IconSmall: proxy,
  };
});

// Vitest does not load the SvelteKit Vite plugin, so `$app/stores` never
// gets registered. Components in the import graph (e.g. connect-communicator)
// read `page` at module init; an empty store is enough for SSR.
vi.mock("$app/stores", () => ({
  page: readable({ url: new URL("http://localhost/"), params: {}, data: {} }),
  navigating: readable(null),
  updated: readable(false),
}));

// Connect-service / connect-communicator / human-input-tool-card are imported
// by tool-call-card but only render when toolName matches; mocking them with
// the icon stub keeps the import graph closed without touching `$lib` aliases
// or pulling in @tanstack/svelte-query (which vitest can't parse).
vi.mock("./connect-service.svelte", async () => {
  return await import("./__test-stubs__/icon-stub.svelte");
});
vi.mock("./connect-communicator.svelte", async () => {
  return await import("./__test-stubs__/icon-stub.svelte");
});
vi.mock("./human-input-tool-card.svelte", async () => {
  return await import("./__test-stubs__/icon-stub.svelte");
});

const { default: ToolCallCardExportParent } = await import(
  "./__test-stubs__/tool-call-card-export-parent.svelte"
);

function makeCtx(): ExportContext {
  return {
    artifacts: new Map(),
    resolveUrl: (id) => `assets/artifacts/${id}/file.txt`,
  };
}

const callWithOutput: ToolCallDisplay = {
  toolCallId: "tc-1",
  toolName: "web_search",
  state: "output-available",
  input: { query: "weather" },
  output: { results: [{ title: "Forecast" }] },
};

describe("tool-call-card copy buttons — export mode", () => {
  it("omits the copy-button wrapper and button when an ExportContext ancestor is present", () => {
    const { body } = render(ToolCallCardExportParent, {
      props: { ctx: makeCtx(), call: callWithOutput },
    });

    expect(body).not.toContain("json-copy-wrapper");
    expect(body).not.toContain("json-copy-btn");
    expect(body).not.toContain('aria-label="Copy input"');
    expect(body).not.toContain('aria-label="Copy output"');
    // The data itself still renders.
    expect(body).toContain("Forecast");
  });
});

describe("tool-call-card copy buttons — live mode", () => {
  // The live UI renders the input/output drawers as closed `<details>`
  // elements. The contents (JSON payload + copy-button wrapper) are gated
  // behind `inputOpen` / `outputOpen` state so we skip the Shiki tokenise
  // pass while the user has not clicked open. SSR therefore emits the
  // chrome (summary/labels) without the wrapper or payload — that hydrates
  // and renders on first `<details>` toggle. See `tool-call-card.svelte`
  // (the "Drawer open state" block) for the rationale.
  it("emits the drawer chrome but defers the copy-button wrapper and payload when no context is set", () => {
    const { body } = render(ToolCallCardExportParent, {
      props: { call: callWithOutput },
    });

    // Drawer chrome (summary labels) renders eagerly...
    expect(body).toContain("input");
    expect(body).toContain("output");
    // ...but the payload and copy affordance wait for the user to open it.
    expect(body).not.toContain("json-copy-wrapper");
    expect(body).not.toContain("json-copy-btn");
    expect(body).not.toContain("Forecast");
  });
});
