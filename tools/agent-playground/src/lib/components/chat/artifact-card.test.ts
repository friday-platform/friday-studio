/**
 * Tests for `artifact-card.svelte`'s two consumption modes:
 *
 * - Export mode: ancestor sets `ExportContext`. Card renders synchronously
 *   from `ctx.artifacts.get(artifactId)` and serves URLs through
 *   `ctx.resolveUrl(id)`. No `fetch` fires.
 * - Live mode: no context set. Existing fetch path runs unchanged. We
 *   verify the loading state in SSR (where `browser=false`, so the load
 *   $effect short-circuits before fetching) — that's the same path the
 *   live UI takes during initial server render.
 */

import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import ArtifactCard from "./artifact-card.svelte";
import type { ArtifactPrefetch, ExportContext } from "./export-context.ts";
import ExportParent from "./__test-stubs__/artifact-card-export-parent.svelte";

function makeContext(prefetch: ArtifactPrefetch): ExportContext {
  return {
    artifacts: new Map([[prefetch.id, prefetch]]),
    resolveUrl: (id) => `assets/artifacts/${id}/file.txt`,
  };
}

describe("artifact-card — export mode", () => {
  it("renders synchronously from prefetched data without firing fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const prefetch: ArtifactPrefetch = {
      id: "art-1",
      title: "Quarterly Report",
      summary: "Auto-generated PDF",
      mimeType: "application/pdf",
      size: 4096,
      originalName: "q4-report.pdf",
    };

    const { body } = render(ExportParent, {
      props: { ctx: makeContext(prefetch), artifactId: prefetch.id },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(body).toContain("Quarterly Report");
    expect(body).toContain("Auto-generated PDF");
    expect(body).toContain("q4-report.pdf");
    // Title-cased mime label.
    expect(body).toContain("PDF");
    // 4096 B → "4.0 KB" via formatBytes.
    expect(body).toContain("4.0 KB");
    // No spinner — loading is false out of the gate.
    expect(body).not.toContain("Loading…");
    fetchSpy.mockRestore();
  });

  it("routes serveUrl through context.resolveUrl rather than the daemon API", () => {
    const prefetch: ArtifactPrefetch = {
      id: "art-img",
      title: "Diagram",
      mimeType: "image/png",
      size: 200,
    };

    const { body } = render(ExportParent, {
      props: { ctx: makeContext(prefetch), artifactId: prefetch.id },
    });

    // imageUrl renders as <img src="…">, populated from serveUrl.
    expect(body).toContain('src="assets/artifacts/art-img/file.txt"');
    // Daemon path must not leak into the rendered HTML.
    expect(body).not.toContain("/api/daemon/");
  });

  it("renders text artifact contents inline without a fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const prefetch: ArtifactPrefetch = {
      id: "art-txt",
      title: "Notes",
      mimeType: "text/plain",
      size: 12,
      contents: "hello world!",
    };

    const { body } = render(ExportParent, {
      props: { ctx: makeContext(prefetch), artifactId: prefetch.id },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(body).toContain("hello world!");
    fetchSpy.mockRestore();
  });

  // Trust-contract violation — every referenced artifactId should be in
  // the prefetch map. If it isn't, surface a clear error instead of
  // spinning a loader the static HTML can never resolve.
  it("surfaces a clear error when the referenced artifactId is missing from context", () => {
    const ctx: ExportContext = {
      artifacts: new Map(),
      resolveUrl: (id) => `assets/artifacts/${id}/file.txt`,
    };

    const { body } = render(ExportParent, {
      props: { ctx, artifactId: "not-prefetched" },
    });

    expect(body).toContain("missing from export context");
    expect(body).not.toContain("Loading…");
  });
});

describe("artifact-card — live mode", () => {
  it("shows the loading spinner during SSR (no context, no fetch in browser=false)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { body } = render(ArtifactCard, { props: { artifactId: "art-live" } });

    // Live UI's load $effect is gated on `browser`, which is false in
    // vitest SSR. The card renders the loading state — same as the
    // initial server render in the real app, before client hydration
    // kicks off the fetch.
    expect(body).toContain("Loading…");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
