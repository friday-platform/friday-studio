import { daemonFactory } from "../../src/factory.ts";
import { deleteLibraryItem } from "./delete.ts";
import { getLibraryItem } from "./get.ts";
import { libraryItems } from "./items.ts";
import { getLibraryStats } from "./stats.ts";
import { listTemplates } from "./templates.ts";

export * from "./schemas.ts";

/**
 * Library API routes for Atlas daemon.
 *
 * Provides HTTP endpoints for managing library items including
 * reports, templates, artifacts, and session archives.
 */
const libraryRoutes = daemonFactory.createApp();

// Mount library items route at base path (GET list, POST create)
libraryRoutes.route("/", libraryItems);

// Mount search route (same functionality as list)
libraryRoutes.route("/search", libraryItems);

// Mount specific routes before parameterized routes
libraryRoutes.route("/templates", listTemplates);
libraryRoutes.route("/stats", getLibraryStats);

// Mount parameterized routes last
libraryRoutes.route("/:itemId", getLibraryItem);
libraryRoutes.route("/:itemId", deleteLibraryItem);

export { libraryRoutes };
