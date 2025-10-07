import { daemonFactory } from "../../src/factory.ts";
import { createLibraryItem } from "./create.ts";
import { deleteLibraryItem } from "./delete.ts";
import { getLibraryItem } from "./get.ts";
import { listLibrary } from "./list.ts";
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

// Mount list/search route at base path
libraryRoutes.route("/", listLibrary);

// Mount search route (same functionality as list)
libraryRoutes.route("/search", listLibrary);

// Mount specific routes before parameterized routes
libraryRoutes.route("/templates", listTemplates);
libraryRoutes.route("/stats", getLibraryStats);

// Mount parameterized routes last
libraryRoutes.route("/:itemId", getLibraryItem);
libraryRoutes.route("/:itemId", deleteLibraryItem);

// Mount POST route for creating items
libraryRoutes.route("/", createLibraryItem);

export { libraryRoutes };
