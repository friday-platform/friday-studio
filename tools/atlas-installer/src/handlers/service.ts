import * as path from "node:path";
import { ServiceAction } from "../constants/actions";
import {
  installMacOSService,
  stopMacOSService,
  uninstallMacOSService,
} from "../services/macos-service";
import { addToShellProfiles, addToSystemPath } from "../services/path-manager";
import {
  installWindowsService,
  stopWindowsService,
  uninstallWindowsService,
} from "../services/windows-service";
import { createStartMenuShortcut } from "../utils/windows-shortcuts";
import type { IPCResult } from "../types";
import { getAtlasEnv, getBinaryPath } from "../utils/atlas-env";
import { getErrorMessage } from "../utils/errors";
import { createLogger } from "../utils/logger";
import { isMac, isWindows } from "../utils/platform";
import { validateBinary } from "../utils/validation";

const logger = createLogger("ServiceHandler");

/**
 * Manage Atlas service (install/start/stop/uninstall)
 */
export async function manageAtlasServiceHandler(
  _event: unknown,
  action: ServiceAction,
): Promise<IPCResult> {
  try {
    const binaryPath = getBinaryPath();

    // Validate binary exists and is executable
    const validationError = validateBinary(binaryPath);
    if (validationError) {
      return validationError;
    }

    // Get Atlas environment variables
    const atlasEnv = getAtlasEnv();

    // Platform-specific service management
    if (isWindows()) {
      switch (action) {
        case ServiceAction.INSTALL: {
          // Install service and update PATH
          const installResult = await installWindowsService(binaryPath);
          if (!installResult.success) {
            return installResult;
          }

          // Update system PATH
          const pathResult = await addToSystemPath(path.dirname(binaryPath));
          if (!pathResult.success) {
            logger.warn(`Could not update PATH: ${pathResult.error}`);
          }

          // Create Start Menu shortcut
          await createStartMenuShortcut();

          return installResult;
        }

        case ServiceAction.STOP: {
          return await stopWindowsService(binaryPath);
        }

        case ServiceAction.UNINSTALL:
          return await uninstallWindowsService(binaryPath);

        case ServiceAction.START:
          return { success: false, error: `Service ${action} not implemented for Windows` };

        default: {
          const _exhaustive: never = action;
          return { success: false, error: `Unknown service action: ${_exhaustive}` };
        }
      }
    }

    if (isMac()) {
      switch (action) {
        case ServiceAction.INSTALL: {
          // Install service and update PATH
          const installResult = await installMacOSService(binaryPath, atlasEnv);
          if (!installResult.success) {
            return installResult;
          }

          // Update shell profiles
          const pathResult = await addToShellProfiles(path.dirname(binaryPath));
          if (!pathResult.success) {
            logger.warn(`Could not update shell profiles: ${pathResult.error}`);
          }

          return installResult;
        }

        case ServiceAction.STOP: {
          return await stopMacOSService(binaryPath, atlasEnv);
        }

        case ServiceAction.START: {
          // On macOS, install handles both install and start
          return await installMacOSService(binaryPath, atlasEnv);
        }

        case ServiceAction.UNINSTALL: {
          return await uninstallMacOSService(binaryPath, atlasEnv);
        }

        default: {
          const _exhaustive: never = action;
          return { success: false, error: `Unknown service action: ${_exhaustive}` };
        }
      }
    }

    return { success: false, error: `Unsupported platform: ${process.platform}` };
  } catch (err) {
    const message = getErrorMessage(err);
    logger.error(`Service ${action} failed`, err);
    return { success: false, error: `Service ${action} failed: ${message}` };
  }
}
