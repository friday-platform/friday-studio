import { daemonFactory } from "../../src/factory.ts";
import { cancelSession } from "./cancel.ts";

/**
 * Atlas daemon session routes.
 * Provides API for session management across workspaces.
 * Mounted at /api/sessions/ on the daemon's HTTP server.
 */
const sessionsRoutes = daemonFactory.createApp();

// DELETE /api/sessions/:sessionId - Cancel a session
sessionsRoutes.route("/:sessionId", cancelSession);

export { sessionsRoutes };
