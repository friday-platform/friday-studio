import { daemonFactory } from "../../src/factory.ts";
import { listWorkspaces } from "./list.ts";
import { getWorkspace } from "./get.ts";
import { createWorkspace } from "./create.ts";

// Export shared schemas and types
export * from "./schemas.ts";

// Create and mount routes
const workspacesRoutes = daemonFactory.createApp();

// Mount individual endpoints
workspacesRoutes.route("/", listWorkspaces);
workspacesRoutes.route("/:workspaceId", getWorkspace);
workspacesRoutes.route("/create", createWorkspace);

export { workspacesRoutes };
