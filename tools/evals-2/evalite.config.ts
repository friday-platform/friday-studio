import { defineConfig } from "evalite/config";

export default defineConfig({
  testTimeout: 120_000, // 120 seconds
  maxConcurrency: 5, // Run up to 100 tests in parallel
  scoreThreshold: 80, // Fail if average score < 80
  cache: false,
});
