import * as path from "node:path";
import type { IPCResult } from "../types";
import { createLogger } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";
import { isWindows, isMac } from "../utils/platform";
import { validateBinary } from "../utils/validation";
import { ServiceAction } from "../constants/actions";
import {
  installWindowsService,
  uninstallWindowsService,
  stopWindowsService,
  createStartMenuShortcut,
} from "../services/windows-service";
import {
  installMacOSService,
  uninstallMacOSService,
  stopMacOSService,
} from "../services/macos-service";
import { addToSystemPath, addToShellProfiles } from "../services/path-manager";
import { getAtlasEnv, getBinaryPath } from "../utils/atlas-env";

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
          const installResult = await installWindowsService(binaryPath, atlasEnv);
          if (!installResult.success) {
            return installResult;
          }

          // Update system PATH
          const pathResult = await addToSystemPath(path.dirname(binaryPath));
          if (!pathResult.success) {
            logger.warn(`Could not update PATH: ${pathResult.error}`);
          }

          // Create Start Menu shortcut
          await createStartMenuShortcut(binaryPath);

          return installResult;
        }

        case ServiceAction.STOP: {
          return await stopWindowsService(binaryPath, atlasEnv);
        }

        case ServiceAction.UNINSTALL:
          return await uninstallWindowsService(binaryPath, atlasEnv);

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
