import { daemonFactory } from "../../src/factory.ts";
import { createWorkspace } from "./create.ts";
import { getWorkspace } from "./get.ts";
import { getWorkspaceConfig } from "./get-config.ts";
import { listWorkspaces } from "./list.ts";
import { updateWorkspace } from "./update.ts";

// Export shared schemas and types
export * from "./schemas.ts";

// Create and mount routes
const workspacesRoutes = daemonFactory.createApp();

// Mount individual endpoints
workspacesRoutes.route("/", listWorkspaces);
workspacesRoutes.route("/:workspaceId", getWorkspace);
workspacesRoutes.route("/:workspaceId/config", getWorkspaceConfig);
workspacesRoutes.route("/:workspaceId/update", updateWorkspace);
workspacesRoutes.route("/create", createWorkspace);

export { workspacesRoutes };
