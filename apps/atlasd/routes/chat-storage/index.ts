import { daemonFactory } from "../../src/factory.ts";
import { getChat } from "./get.ts";
import { updateChat } from "./update.ts";

export * from "./schemas.ts";

/**
 * Chat storage API routes for Atlas daemon.
 *
 * Provides HTTP endpoints for managing conversation state across sessions.
 * Each streamId maps to a conversation history used by SessionSupervisor
 * for context persistence between signal processing cycles.
 */
const chatStorageRoutes = daemonFactory.createApp();

chatStorageRoutes.route("/:streamId", getChat);
chatStorageRoutes.route("/:streamId", updateChat);

export { chatStorageRoutes };
