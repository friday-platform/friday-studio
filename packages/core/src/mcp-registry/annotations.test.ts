import { describe, it } from "vitest";
import { getAnnotation, isOfficialCanonicalName, REGISTRY_ANNOTATIONS } from "./annotations.ts";

describe("getAnnotation", () => {
  it("returns the curated record for a known canonical name", ({ expect }) => {
    expect(getAnnotation("com.stripe/mcp")).toEqual({ displayName: "Stripe", isOfficial: true });
  });

  it("includes providerId when the entry routes to an existing Link provider", ({ expect }) => {
    expect(getAnnotation("app.linear/linear")).toEqual({
      displayName: "Linear",
      providerId: "linear",
      isOfficial: true,
    });
  });

  it("returns undefined for a canonical name not in the overlay", ({ expect }) => {
    expect(getAnnotation("not.in/map")).toBeUndefined();
  });
});

describe("isOfficialCanonicalName", () => {
  it("is true for an endorsed entry", ({ expect }) => {
    expect(isOfficialCanonicalName("com.stripe/mcp")).toBe(true);
  });

  it("is false for a canonical name not in the overlay", ({ expect }) => {
    expect(isOfficialCanonicalName("not.in/map")).toBe(false);
  });

  it("defaults to false — `isOfficial` is opt-in, never inferred from existence", ({ expect }) => {
    // Guards the `?? false` default: an annotation can carry notes or a display
    // name without being endorsed. Asserts the contract across the whole table,
    // so a future notes-only entry stays non-official unless it opts in.
    for (const [name, annotation] of Object.entries(REGISTRY_ANNOTATIONS)) {
      expect(isOfficialCanonicalName(name)).toBe(annotation.isOfficial ?? false);
    }
  });
});
