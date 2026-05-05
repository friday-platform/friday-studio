import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { ArtifactPrefetch, ExportContext } from "./export-context.ts";
import Child from "./__test-stubs__/export-context-child.svelte";
import Parent from "./__test-stubs__/export-context-parent.svelte";

describe("export-context", () => {
  it("getExportContext() returns undefined outside a context tree", () => {
    const { body } = render(Child);
    expect(body).toContain(">absent<");
  });

  it("getExportContext() returns the value set by an ancestor", () => {
    const artifact: ArtifactPrefetch = {
      id: "art-1",
      title: "Doc",
      mimeType: "text/plain",
      size: 12,
    };
    const ctx: ExportContext = {
      artifacts: new Map([[artifact.id, artifact]]),
      resolveUrl: (id) => `assets/artifacts/${id}/file.txt`,
    };

    const { body } = render(Parent, { props: { ctx } });

    expect(body).toContain('"artifactIds":["art-1"]');
    expect(body).toContain('"resolved":"assets/artifacts/probe-id/file.txt"');
  });
});
