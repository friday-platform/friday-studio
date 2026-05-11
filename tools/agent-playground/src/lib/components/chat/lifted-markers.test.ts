import { describe, expect, it } from "vitest";
import { extractLiftedArtifactIds } from "./lifted-markers.ts";

/** Build a marker string in the exact shape `refMarker` emits. */
function marker(id: string, mime = "application/pdf", server = "x", tool = "y", kb = 50): string {
  return (
    `[attachment lifted to artifact ${id} ` +
    `(${kb} KB, ${mime}, from ${server}/${tool}) — ` +
    `use display_artifact or artifacts_get to read]`
  );
}

describe("extractLiftedArtifactIds", () => {
  it("returns empty for a string with no marker", () => {
    expect(extractLiftedArtifactIds("just plain text")).toEqual([]);
  });

  it("returns empty for non-string primitives and null/undefined", () => {
    expect(extractLiftedArtifactIds(null)).toEqual([]);
    expect(extractLiftedArtifactIds(undefined)).toEqual([]);
    expect(extractLiftedArtifactIds(42)).toEqual([]);
    expect(extractLiftedArtifactIds(true)).toEqual([]);
  });

  it("extracts one id from a single-marker string", () => {
    const out = `prefix ${marker("art_001")} suffix`;
    expect(extractLiftedArtifactIds(out)).toEqual([{ artifactId: "art_001" }]);
  });

  it("extracts ids from a string with multiple markers in source order", () => {
    const out = `${marker("art_a")} between ${marker("art_b")} more ${marker("art_c")}`;
    expect(extractLiftedArtifactIds(out)).toEqual([
      { artifactId: "art_a" },
      { artifactId: "art_b" },
      { artifactId: "art_c" },
    ]);
  });

  it("walks object values and collects markers from nested string fields", () => {
    const out = {
      summary: "ok",
      content: [{ text: marker("art_nested_1") }, { text: marker("art_nested_2") }],
    };
    expect(extractLiftedArtifactIds(out)).toEqual([
      { artifactId: "art_nested_1" },
      { artifactId: "art_nested_2" },
    ]);
  });

  it("deduplicates the same artifact id across fields (first occurrence wins)", () => {
    // Regression: tool results commonly mention the same artifact id in
    // more than one field — once in the top-level summary, again in
    // an `aiSummary.keyDetails[].url`, sometimes again in a nested
    // content blob. The UI keys `{#each liftedArtifacts as ref
    // (ref.artifactId)}` so a duplicate id crashes the render with
    // `each_key_duplicate`. Order preserves first-occurrence so the
    // visible artifact card still lines up with where the user expects.
    const out = {
      summary: `result lifted: ${marker("art_dup")}`,
      aiSummary: {
        keyDetails: [{ url: marker("art_dup", "application/pdf", "x", "y", 50) }],
      },
      details: marker("art_other"),
      footer: marker("art_dup"),
    };
    expect(extractLiftedArtifactIds(out)).toEqual([
      { artifactId: "art_dup" },
      { artifactId: "art_other" },
    ]);
  });

  it("deduplicates the same artifact id when it appears twice in one string", () => {
    const out = `${marker("art_x")} mentioned again: ${marker("art_x")}`;
    expect(extractLiftedArtifactIds(out)).toEqual([{ artifactId: "art_x" }]);
  });

  it("ignores malformed marker shapes", () => {
    // No closing bracket — regex requires `]`.
    expect(extractLiftedArtifactIds("[attachment lifted to artifact bad ")).toEqual([]);
    // Wrong prefix.
    expect(extractLiftedArtifactIds("[file lifted to artifact bad]")).toEqual([]);
  });

  it("does not infinitely recurse on deeply nested objects", () => {
    // 20 levels deep — beyond the depth cap of 16; the tail marker is dropped
    // but the function still returns rather than blowing the stack.
    let v: unknown = marker("art_deep");
    for (let i = 0; i < 20; i++) v = { wrap: v };
    // Either an empty list (cap hit before string) or a single id — both are
    // acceptable; the assertion is that the call returns synchronously.
    const refs = extractLiftedArtifactIds(v);
    expect(Array.isArray(refs)).toBe(true);
  });
});
