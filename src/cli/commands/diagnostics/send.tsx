import { sendDiagnostics } from "@atlas/diagnostics";
import { ServiceManager } from "../../../services/service-manager.ts";
import { getVersionInfo } from "../../../utils/version.ts";

export const command = "send";
export const desc = "Send diagnostic information to Atlas developers";

export const handler = async (): Promise<void> => {
  try {
    // Get service manager status for daemon PID
    const serviceManager = ServiceManager.getInstance();
    const getServiceStatus = async () => {
      const status = await serviceManager.getStatus();
      return { running: status.running, pid: status.pid };
    };

    // Get version info
    const versionInfo = getVersionInfo();

    // Send diagnostics with options
    await sendDiagnostics({ getServiceStatus, versionInfo });

    Deno.exit(0);
  } catch (error) {
    console.error("Failed to send diagnostics:", error);
    Deno.exit(1);
  }
};
