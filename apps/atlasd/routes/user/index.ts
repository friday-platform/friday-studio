import { daemonFactory } from "../../src/factory.ts";
import { getUser } from "./get.ts";

// Create and mount routes
const userRoutes = daemonFactory.createApp();

// Mount individual endpoints
userRoutes.route("/", getUser);

export { userRoutes };
