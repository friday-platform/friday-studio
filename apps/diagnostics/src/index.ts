import { getAtlasClient } from "@atlas/client";
import { DiagnosticsCollector } from "./diagnostics.ts";

let gzipPath: string | undefined;

try {
  // Collect diagnostics
  const collector = new DiagnosticsCollector();
  gzipPath = await collector.collectAndArchive();

  // Check size
  const fileInfo = await Deno.stat(gzipPath);
  if (fileInfo.size > 100 * 1024 * 1024) {
    // 100MB
    throw new Error("Diagnostic archive too large (>100MB). Please contact support.");
  }

  // Upload via client
  const client = getAtlasClient();
  await client.sendDiagnostics(gzipPath);

  // // Clean up temp file
  await Deno.remove(gzipPath).catch(() => {}); // Ignore cleanup errors

  // Reset to idle after showing success for a moment
  console.log("Diagnostics sent successfully!");
} catch (err) {
  // Try to clean up on error too
  if (gzipPath) {
    await Deno.remove(gzipPath).catch(() => {});
  }

  // Reset to idle after showing error for a moment
  console.error(err instanceof Error ? err.message : String(err));
} finally {
  Deno.exit();
}
