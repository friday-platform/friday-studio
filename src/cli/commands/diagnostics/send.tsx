import process from "node:process";
import { sendDiagnostics } from "@atlas/diagnostics";
import { stringifyError } from "@atlas/utils";
import { ServiceManager } from "../../../services/service-manager.ts";
import { getVersionInfo } from "../../../utils/version.ts";
import { errorOutput } from "../../utils/output.ts";

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

    process.exit(0);
  } catch (error) {
    // Extract clean error message for user-facing output
    errorOutput(stringifyError(error));
    process.exit(1);
  }
};
