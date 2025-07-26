import { daemonFactory } from "../../src/factory.ts";
import { listConversations } from "./list.ts";
import { getConversation } from "./get.ts";
import { createMessage } from "./create.ts";
import { deleteConversation } from "./delete.ts";

// Export shared schemas and types
export * from "./schemas.ts";

// Create and mount routes
const conversationStorageRoutes = daemonFactory.createApp();

// Mount individual endpoints
conversationStorageRoutes.route("/", listConversations);
conversationStorageRoutes.route("/:streamId", getConversation);
conversationStorageRoutes.route("/:streamId", createMessage);
conversationStorageRoutes.route("/:streamId", deleteConversation);

export { conversationStorageRoutes };
