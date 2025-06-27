/**
 * Configuration package for Atlas
 *
 * This package provides:
 * - Configuration schemas using Zod v4
 * - Type definitions for all configuration objects
 * - Validation utilities
 * - ConfigLoader class (to be implemented)
 */

// Export all schemas and types
export * from "./src/schemas.ts";
export * from "./src/validation.ts";

// Export ConfigLoader
export { ConfigLoader } from "./src/config-loader.ts";

// Export default configurations
export { supervisorDefaults } from "./src/defaults/supervisor-defaults.ts";
export { atlasDefaults } from "./src/defaults/atlas-defaults.ts";
