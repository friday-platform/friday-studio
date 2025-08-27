import { daemonFactory } from "../../src/factory.ts";
import { createStreamRoute } from "./create.ts";
import { sseStreamRoute } from "./sse.ts";
import { sendMessageRoute } from "./message.ts";
import { emitEventRoute } from "./emit.ts";

/**
 * Stream management API routes for Atlas daemon.
 *
 * Provides SSE-based real-time communication channels for agents
 * to stream UI messages to clients. Streams act as communication
 * bridges between Atlas sessions and external clients.
 */
const streamsRoutes = daemonFactory.createApp();

streamsRoutes.route("/", createStreamRoute);
streamsRoutes.route("/:streamId/stream", sseStreamRoute);
streamsRoutes.route("/:streamId", sendMessageRoute);
streamsRoutes.route("/:streamId/emit", emitEventRoute);

export { streamsRoutes };
