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
    const out = `prefix ${marker("aaaaaaaa-aaaa-aaaa-aaaa-000000000001")} suffix`;
    expect(extractLiftedArtifactIds(out)).toEqual([{ artifactId: "aaaaaaaa-aaaa-aaaa-aaaa-000000000001" }]);
  });

  it("extracts ids from a string with multiple markers in source order", () => {
    const out = `${marker("aaaaaaaa-aaaa-aaaa-aaaa-00000000000a")} between ${marker("bbbbbbbb-bbbb-bbbb-bbbb-00000000000b")} more ${marker("cccccccc-cccc-cccc-cccc-00000000000c")}`;
    expect(extractLiftedArtifactIds(out)).toEqual([
      { artifactId: "aaaaaaaa-aaaa-aaaa-aaaa-00000000000a" },
      { artifactId: "bbbbbbbb-bbbb-bbbb-bbbb-00000000000b" },
      { artifactId: "cccccccc-cccc-cccc-cccc-00000000000c" },
    ]);
  });

  it("walks object values and collects markers from nested string fields", () => {
    const out = {
      summary: "ok",
      content: [{ text: marker("11111111-1111-1111-1111-111111111111") }, { text: marker("22222222-2222-2222-2222-222222222222") }],
    };
    expect(extractLiftedArtifactIds(out)).toEqual([
      { artifactId: "11111111-1111-1111-1111-111111111111" },
      { artifactId: "22222222-2222-2222-2222-222222222222" },
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
      summary: `result lifted: ${marker("dddddddd-dddd-dddd-dddd-dddddddddddd")}`,
      aiSummary: {
        keyDetails: [{ url: marker("dddddddd-dddd-dddd-dddd-dddddddddddd", "application/pdf", "x", "y", 50) }],
      },
      details: marker("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"),
      footer: marker("dddddddd-dddd-dddd-dddd-dddddddddddd"),
    };
    expect(extractLiftedArtifactIds(out)).toEqual([
      { artifactId: "dddddddd-dddd-dddd-dddd-dddddddddddd" },
      { artifactId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" },
    ]);
  });

  it("deduplicates the same artifact id when it appears twice in one string", () => {
    const out = `${marker("ffffffff-ffff-ffff-ffff-ffffffffffff")} mentioned again: ${marker("ffffffff-ffff-ffff-ffff-ffffffffffff")}`;
    expect(extractLiftedArtifactIds(out)).toEqual([{ artifactId: "ffffffff-ffff-ffff-ffff-ffffffffffff" }]);
  });

  it("ignores malformed marker shapes", () => {
    // No closing bracket — regex requires `]`.
    expect(extractLiftedArtifactIds("[attachment lifted to artifact bad ")).toEqual([]);
    // Wrong prefix.
    expect(extractLiftedArtifactIds("[file lifted to artifact bad]")).toEqual([]);
  });

  it("respects the depth cap and drops markers below it", () => {
    // 20 levels of wrap — beyond the depth cap of 16. The string
    // (and its marker) sits at depth 20, so the walker bails before
    // ever reaching it and the returned list is empty.
    let v: unknown = marker("99999999-9999-9999-9999-999999999999");
    for (let i = 0; i < 20; i++) v = { wrap: v };
    expect(extractLiftedArtifactIds(v)).toEqual([]);
  });

  it("extracts markers exactly at the depth cap", () => {
    // 16 wraps puts the string at depth 16. The cap is inclusive
    // (depth > 16 returns), so the marker should still be picked up.
    let v: unknown = marker("cccccccc-cccc-cccc-cccc-ccccccccccca");
    for (let i = 0; i < 16; i++) v = { wrap: v };
    expect(extractLiftedArtifactIds(v)).toEqual([{ artifactId: "cccccccc-cccc-cccc-cccc-ccccccccccca" }]);
  });
});
