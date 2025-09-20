import { getAtlasClient } from "@atlas/client";
import { createLogger } from "@atlas/logger";
import { DiagnosticsCollector } from "./diagnostics.ts";

const log = createLogger({ component: "diagnostics" });
let gzipPath: string | undefined;

try {
  log.info("Atlas Diagnostics Collection Starting...");
  log.info("Gathering system information...");

  // Collect diagnostics
  const collector = new DiagnosticsCollector();
  gzipPath = await collector.collectAndArchive();

  // Check size
  log.info("Verifying archive size...");
  const fileInfo = await Deno.stat(gzipPath);
  const sizeMB = (fileInfo.size / 1024 / 1024).toFixed(2);
  log.info(`Archive size: ${sizeMB} MB`);

  if (fileInfo.size > 100 * 1024 * 1024) {
    // 100MB
    throw new Error("Diagnostic archive too large (>100MB). Please contact support.");
  }

  // Upload via client
  log.info("Uploading diagnostics to Atlas...");
  const client = getAtlasClient();
  await client.sendDiagnostics(gzipPath);

  // // Clean up temp file
  await Deno.remove(gzipPath).catch(() => {}); // Ignore cleanup errors

  // Reset to idle after showing success for a moment
  log.info("✓ Diagnostics sent successfully!");
} catch (err) {
  // Try to clean up on error too
  if (gzipPath) {
    await Deno.remove(gzipPath).catch(() => {});
  }

  // Reset to idle after showing error for a moment
  log.error("✗ Error: " + (err instanceof Error ? err.message : String(err)));
} finally {
  Deno.exit();
}
