import { getAtlasClient } from "@atlas/client";
import { createLogger } from "@atlas/logger";
import { DiagnosticsCollector, type DiagnosticsCollectorOptions } from "./collector.ts";

const log = createLogger({ component: "diagnostics" });

export async function sendDiagnostics(options: DiagnosticsCollectorOptions = {}) {
  let gzipPath: string | undefined;

  try {
    log.info("Atlas Diagnostics Collection Starting...");
    log.info("Gathering system information...");

    // Collect diagnostics
    const collector = new DiagnosticsCollector(options);
    gzipPath = await collector.collectAndArchive();

    // Check size
    log.info("Verifying archive size...");
    const fileInfo = await Deno.stat(gzipPath);
    const sizeMB = (fileInfo.size / 1024 / 1024).toFixed(2);
    log.info(`Archive size: ${sizeMB} MB`);

    if (fileInfo.size > 500 * 1024 * 1024) {
      // 500MB
      throw new Error(
        "Diagnostic archive too large (>500MB). Please contact support@tempest.team.",
      );
    }

    // Upload via client
    log.info("Uploading diagnostics to Atlas...");
    const client = getAtlasClient();
    await client.sendDiagnostics(gzipPath);

    // Reset to idle after showing success for a moment
    log.info("✓ Diagnostics sent successfully!");
  } finally {
    // Clean up temp file
    if (gzipPath) {
      await Deno.remove(gzipPath).catch(() => {});
    }
  }
}
