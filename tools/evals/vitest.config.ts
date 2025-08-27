import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["dotenv/config"], testTimeout: 240000 },
  resolve: {
    alias: {
      "@atlas/agent-sdk": resolve(__dirname, "../../packages/agent-sdk/src/index.ts"),
      "@atlas/bundled-agents": resolve(__dirname, "../../packages/bundled-agents/src/index.ts"),
    },
  },
});
