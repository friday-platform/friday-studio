/**
 * Central export for all IPC handlers
 */

// Basic handlers
export {
  getPlatformHandler,
  createAtlasDirHandler,
  checkExistingApiKeyHandler,
  saveAtlasNpxPathHandler,
  saveAtlasKeyHandler,
  quitAppHandler,
} from "./basic";

// Binary handlers
export { installAtlasBinaryHandler } from "./binary";
export { checkAtlasBinaryHandler } from "./check-binary";

// Service handlers
export { manageAtlasServiceHandler } from "./service";

// Daemon handlers
export {
  checkAtlasDaemonStatus,
  manageAtlasDaemon,
} from "./daemon";

// EULA handlers
export { getEulaTextHandler } from "./eula";
