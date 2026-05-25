/**
 * Unit tests for the Settings → Workspace Details state helpers.
 *
 * Covers the page-level invariants called out by Task 6's testing
 * decisions:
 *
 * - Test case #8 — re-seed gating. The page uses `seededFor` to guard
 *   `$effect`-driven seeding. The dirty derivation here is the contract
 *   that makes that gate observable: dirty stays true across a refetch
 *   that returns the same data (i.e. effective_value hasn't moved). The
 *   page's $effect-stamp guard is exercised by component-level wiring in
 *   QA; the dirty-derivation half lives here.
 * - Test case #9 second half — Reset → Save → DELETE fires → refetch
 *   shows default. We test the edits→payload split that drives the
 *   DELETE step, plus the `pruneLandedEdits` call that drops the cleared
 *   edit once the commit lands.
 * - Test case #13 — Discard resets BOTH. The seed-from-config helpers
 *   exercised here are what the page's Discard handler calls; combined
 *   with an `edits = {}` reset they restore the form in one click.
 */
import type { VariableState } from "@atlas/workspace";
import { describe, expect, it } from "vitest";
import {
  buildIdentityPatch,
  identityDirty,
  pruneLandedEdits,
  seedIdentityFromConfig,
  splitVariableEdits,
  summarizeCommitResults,
  variablesDirty,
  type IdentityInputs,
  type VariableEdits,
} from "./details-state.ts";

function stringVariable(
  name: string,
  overrides: {
    default?: string;
    effective_value?: string | null;
    source?: VariableState["source"];
  } = {},
): VariableState {
  const schema =
    overrides.default !== undefined
      ? { type: "string" as const, default: overrides.default }
      : { type: "string" as const };
  return {
    name,
    declaration: { schema },
    value: overrides.source === "env" ? (overrides.effective_value ?? null) : null,
    effective_value: overrides.effective_value ?? overrides.default ?? null,
    source: overrides.source ?? (overrides.default !== undefined ? "default" : "unset"),
    is_filled: overrides.source === "env" || overrides.default !== undefined,
  };
}

function emptyInputs(): IdentityInputs {
  return { name: "", description: "", progressTimeout: "", maxTotalTimeout: "" };
}

describe("seedIdentityFromConfig", () => {
  it("falls back to empty strings for missing fields", () => {
    expect(seedIdentityFromConfig(null)).toEqual({
      name: "",
      description: "",
      progressTimeout: "",
      maxTotalTimeout: "",
    });
    expect(seedIdentityFromConfig({})).toEqual({
      name: "",
      description: "",
      progressTimeout: "",
      maxTotalTimeout: "",
    });
  });

  it("mirrors the workspace identity block when fully populated", () => {
    expect(
      seedIdentityFromConfig({
        name: "Acme",
        description: "A workspace",
        timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" },
      }),
    ).toEqual({
      name: "Acme",
      description: "A workspace",
      progressTimeout: "2m",
      maxTotalTimeout: "30m",
    });
  });
});

describe("identityDirty", () => {
  const seed = seedIdentityFromConfig({
    name: "Acme",
    description: "old",
    timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" },
  });

  it("is false when inputs equal the seed", () => {
    expect(identityDirty({ ...seed }, seed)).toBe(false);
  });

  it("is true on any field divergence", () => {
    expect(identityDirty({ ...seed, name: "Acme2" }, seed)).toBe(true);
    expect(identityDirty({ ...seed, description: "new" }, seed)).toBe(true);
    expect(identityDirty({ ...seed, progressTimeout: "3m" }, seed)).toBe(true);
    expect(identityDirty({ ...seed, maxTotalTimeout: "1h" }, seed)).toBe(true);
  });
});

describe("buildIdentityPatch", () => {
  it("returns ok+undefined when nothing changed", () => {
    const seed = seedIdentityFromConfig({ name: "Acme" });
    expect(buildIdentityPatch({ ...seed }, seed)).toEqual({ kind: "ok", patch: undefined });
  });

  it("rejects empty name", () => {
    const seed = seedIdentityFromConfig({ name: "Acme" });
    const result = buildIdentityPatch({ ...seed, name: "   " }, seed);
    expect(result).toEqual({ kind: "error", message: "Name is required" });
  });

  it("trims name into the patch when it changes", () => {
    const seed = seedIdentityFromConfig({ name: "Acme" });
    const result = buildIdentityPatch({ ...seed, name: "  Renamed  " }, seed);
    expect(result).toEqual({ kind: "ok", patch: { name: "Renamed" } });
  });

  it("sends description verbatim (no trim) when it changes", () => {
    const seed = seedIdentityFromConfig({ name: "Acme", description: "old" });
    const result = buildIdentityPatch({ ...seed, description: "  new value  " }, seed);
    expect(result).toEqual({ kind: "ok", patch: { description: "  new value  " } });
  });

  it("requires both timeout fields when any timeout changes", () => {
    const seed = seedIdentityFromConfig({
      name: "Acme",
      timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" },
    });
    const result = buildIdentityPatch(
      { ...seed, progressTimeout: "3m", maxTotalTimeout: "" },
      seed,
    );
    expect(result).toEqual({
      kind: "error",
      message: "Both timeout fields are required to change timeouts",
    });
  });

  it("includes the full timeout block when any sub-field changes", () => {
    const seed = seedIdentityFromConfig({
      name: "Acme",
      timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" },
    });
    const result = buildIdentityPatch(
      { ...seed, progressTimeout: "5m", maxTotalTimeout: "30m" },
      seed,
    );
    expect(result).toEqual({
      kind: "ok",
      patch: { timeout: { progressTimeout: "5m", maxTotalTimeout: "30m" } },
    });
  });
});

describe("variablesDirty (test #8 — refetch preservation)", () => {
  it("is false when edits map is empty", () => {
    const variables = [stringVariable("EMAIL", { effective_value: "x@y.com", source: "env" })];
    expect(variablesDirty({}, variables)).toBe(false);
  });

  it("is true when a user typed a different value than the effective_value", () => {
    const variables = [stringVariable("EMAIL", { effective_value: "x@y.com", source: "env" })];
    expect(variablesDirty({ EMAIL: "new@y.com" }, variables)).toBe(true);
  });

  it("is true when the user clicked Reset on a non-default row", () => {
    const variables = [
      stringVariable("EMAIL", { effective_value: "x@y.com", source: "env", default: "z@y.com" }),
    ];
    expect(variablesDirty({ EMAIL: null }, variables)).toBe(true);
  });

  it("is false when Reset is clicked on a row already showing the default (no-op)", () => {
    const variables = [
      stringVariable("EMAIL", {
        effective_value: "z@y.com",
        source: "default",
        default: "z@y.com",
      }),
    ];
    expect(variablesDirty({ EMAIL: null }, variables)).toBe(false);
  });

  it("survives a refetch that returned the same data — dirty stays true (test #8)", () => {
    // The page's $effect re-seeding is gated on dataUpdatedAt advancing.
    // A refetch that returns the same payload doesn't change variables[]
    // — and therefore doesn't change the dirty result. This is the
    // invariant test #8 demands: background refetch must not clobber
    // user edits.
    const variables1 = [stringVariable("EMAIL", { effective_value: "x@y.com", source: "env" })];
    const edits: VariableEdits = { EMAIL: "draft" };
    expect(variablesDirty(edits, variables1)).toBe(true);

    // Same row, identical shape — what a same-data refetch would
    // produce in the page. The page's `seededFor` guard prevents the
    // edits map from being re-seeded; this assertion is the data-side
    // guarantee that pairs with that gate.
    const variables2 = [stringVariable("EMAIL", { effective_value: "x@y.com", source: "env" })];
    expect(variablesDirty(edits, variables2)).toBe(true);
  });
});

describe("splitVariableEdits", () => {
  it("partitions strings into sets and nulls into deletes", () => {
    const edits: VariableEdits = {
      a: "value-a",
      b: null,
      c: "value-c",
      d: null,
    };
    expect(splitVariableEdits(edits)).toEqual({
      variableSets: { a: "value-a", c: "value-c" },
      variableDeletes: ["b", "d"],
    });
  });

  it("handles the empty case", () => {
    expect(splitVariableEdits({})).toEqual({ variableSets: {}, variableDeletes: [] });
  });

  it("Reset-only edit ships purely as a delete (test #9 second half)", () => {
    // The composite mutation walks variableSets → PUTs, then
    // variableDeletes → DELETEs. A row the user reset must NOT generate
    // a PUT (which would write the default back as a literal value);
    // only the DELETE fires, after which the resolver falls back to
    // schema default on refetch.
    const edits: VariableEdits = { THRESHOLD: null };
    const split = splitVariableEdits(edits);
    expect(split).toEqual({ variableSets: {}, variableDeletes: ["THRESHOLD"] });
  });
});

describe("pruneLandedEdits (test #9 second half — drop landed edits)", () => {
  const envKey = (name: string): string => name.toUpperCase();

  it("returns the same map when no commitResults are present", () => {
    const edits: VariableEdits = { a: "x" };
    expect(pruneLandedEdits(edits, [], envKey)).toEqual(edits);
  });

  it("drops only landed edits, keeping failed ones for retry", () => {
    const edits: VariableEdits = { first: "x", second: "y" };
    const result = pruneLandedEdits(
      edits,
      [
        { key: "FIRST", status: "ok" },
        { key: "SECOND", status: "error" },
      ],
      envKey,
    );
    expect(result).toEqual({ second: "y" });
  });

  it("ignores the identity commit row", () => {
    const edits: VariableEdits = { a: "x" };
    expect(
      pruneLandedEdits(edits, [{ key: "identity", status: "ok" }], envKey),
    ).toEqual({ a: "x" });
  });

  it("drops a successful delete (Reset → Save landed)", () => {
    const edits: VariableEdits = { threshold: null };
    const result = pruneLandedEdits(
      edits,
      [{ key: "THRESHOLD", status: "ok" }],
      envKey,
    );
    expect(result).toEqual({});
  });
});

describe("summarizeCommitResults", () => {
  it("renders both saved and failed when present", () => {
    expect(
      summarizeCommitResults([
        { key: "identity", status: "ok" },
        { key: "FIRST", status: "ok" },
        { key: "SECOND", status: "error", error: "boom" },
      ]),
    ).toBe("Saved: identity, FIRST — Failed: SECOND");
  });

  it("renders only saved when nothing failed", () => {
    expect(summarizeCommitResults([{ key: "identity", status: "ok" }])).toBe("Saved: identity");
  });

  it("renders only failed when nothing landed", () => {
    expect(summarizeCommitResults([{ key: "FIRST", status: "error" }])).toBe("Failed: FIRST");
  });
});

describe("integration — Discard resets BOTH (test #13)", () => {
  it("seed + edits cleared = identity inputs and variables back to clean", () => {
    // The page's Discard handler does two things in one click:
    //   1. resetIdentity()  → inputs = seed
    //   2. variableEdits = {}
    // After both, both dirty derivations must report false. That's the
    // observable signature of "Discard reset both" — a single Save
    // button transition from enabled to disabled.
    const seed = seedIdentityFromConfig({
      name: "Acme",
      description: "old",
      timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" },
    });
    const dirtyInputs: IdentityInputs = { ...seed, name: "draft" };
    const dirtyEdits: VariableEdits = { EMAIL: "draft@y.com" };
    const variables = [stringVariable("EMAIL", { effective_value: "x@y.com", source: "env" })];

    expect(identityDirty(dirtyInputs, seed)).toBe(true);
    expect(variablesDirty(dirtyEdits, variables)).toBe(true);

    // Discard click.
    const resetInputs: IdentityInputs = { ...seed };
    const resetEdits: VariableEdits = {};

    expect(identityDirty(resetInputs, seed)).toBe(false);
    expect(variablesDirty(resetEdits, variables)).toBe(false);
  });
});

describe("integration — error wiring is the page's responsibility", () => {
  it("emptyInputs/seed pair is the canonical baseline", () => {
    // Sanity check: when the workspace has no identity (null config),
    // the seed and empty inputs match, so the form starts clean.
    const seed = seedIdentityFromConfig(null);
    expect(identityDirty(emptyInputs(), seed)).toBe(false);
  });
});
