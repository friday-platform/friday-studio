import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("architecture", () => {
  it("must not contain .server.ts files (adapter-static has no runtime server)", () => {
    const allFiles = readdirSync(srcDir, { recursive: true, encoding: "utf-8" });
    const serverFiles = allFiles.filter((f: string) => f.endsWith(".server.ts"));

    expect(
      serverFiles,
      "Server files (hooks.server.ts, +layout.server.ts, +page.server.ts) cause " +
        "SvelteKit to fetch __data.json at runtime. With adapter-static + nginx, " +
        "these requests return index.html instead of JSON → JSON.parse crashes. " +
        "Use universal load (+layout.ts / +page.ts) or client-side code instead.",
    ).toEqual([]);
  });
});
