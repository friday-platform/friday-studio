/**
 * Central export for all IPC handlers
 */

// Basic handlers
export {
  checkExistingApiKeyHandler,
  createAtlasDirHandler,
  getPlatformHandler,
  quitAppHandler,
  saveAtlasKeyHandler,
  saveAtlasNpxPathHandler,
} from "./basic";

// Binary handlers
export { installAtlasBinaryHandler } from "./binary";
export { checkAtlasBinaryHandler } from "./check-binary";
// EULA handlers
export { getEulaTextHandler } from "./eula";
// Service handlers
export { manageAtlasServiceHandler } from "./service";
