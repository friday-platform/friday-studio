import { daemonFactory } from "../../src/factory.ts";
import { triggerSignal } from "./trigger.ts";

// Export shared schemas and types
export * from "./schemas.ts";

// Create and mount routes
const signalRoutes = daemonFactory.createApp();

// Mount individual endpoints
signalRoutes.route("/:workspaceId/signals/:signalId", triggerSignal);

export { signalRoutes };
