import process from "node:process";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
    coverage: { provider: "v8" },
    include: ["**/*.{test,spec,eval}.?(c|m)[jt]s?(x)"],
    // Exclude eval files in CI - they require ATLAS_KEY credentials
    exclude: process.env.GITHUB_ACTIONS
      ? ["**/node_modules/**", "**/*.eval.?(c|m)[jt]s?(x)"]
      : ["**/node_modules/**"],
  },
});
