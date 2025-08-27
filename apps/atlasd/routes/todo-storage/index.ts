import { daemonFactory } from "../../src/factory.ts";
import { createTodos } from "./create.ts";
import { deleteTodos } from "./delete.ts";
import { getTodos } from "./get.ts";

/**
 * Atlas daemon todo storage routes.
 * Provides CRUD API for stream-based todo persistence.
 * Mounted at /todo-storage/ on the daemon's HTTP server.
 */

const todoStorageRoutes = daemonFactory.createApp();

todoStorageRoutes.route("/:streamId", getTodos);
todoStorageRoutes.route("/:streamId", createTodos);
todoStorageRoutes.route("/:streamId", deleteTodos);

export { todoStorageRoutes };
