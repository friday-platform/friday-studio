import { getVersionInfo } from "@atlas/utils";
import { daemonFactory } from "../src/factory.ts";

const versionRoutes = daemonFactory.createApp().get("/", (c) => {
  return c.json(getVersionInfo());
});

export { versionRoutes };
export type VersionRoutes = typeof versionRoutes;
