import { daemonFactory } from "../../src/factory.ts";
import { listTodoStreams } from "./list.ts";
import { getTodos } from "./get.ts";
import { createTodos } from "./create.ts";
import { deleteTodos } from "./delete.ts";

// Export shared schemas and types
export * from "./schemas.ts";

// Create and mount routes
const todoStorageRoutes = daemonFactory.createApp();

// Mount individual endpoints
todoStorageRoutes.route("/", listTodoStreams);
todoStorageRoutes.route("/:streamId", getTodos);
todoStorageRoutes.route("/:streamId", createTodos);
todoStorageRoutes.route("/:streamId", deleteTodos);

export { todoStorageRoutes };
