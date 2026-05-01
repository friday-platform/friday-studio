/**
 * Drift-detection test: ensures the duplicated OutlineRefSchema in
 * @atlas/bundled-agents/shared-schemas stays in sync with the canonical
 * definition in @atlas/core.
 *
 * The duplication exists because @atlas/bundled-agents cannot import from
 * @atlas/core (circular dependency). This test catches silent divergence.
 */

import { OutlineRefSchema as BundledOutlineRefSchema } from "@atlas/bundled-agents/shared-schemas";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OutlineRefSchema as CoreOutlineRefSchema } from "./outline-ref.ts";

describe("OutlineRefSchema drift detection", () => {
  it("bundled-agents OutlineRefSchema matches core OutlineRefSchema", () => {
    const coreJSON = z.toJSONSchema(CoreOutlineRefSchema);
    const bundledJSON = z.toJSONSchema(BundledOutlineRefSchema);

    expect(bundledJSON).toEqual(coreJSON);
  });
});
