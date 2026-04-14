import path from "node:path";
import { MdNarrativeCorpus } from "@atlas/adapters-md";
import { logger } from "@atlas/logger";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { daemonFactory } from "../../src/factory.ts";

export const memoryNarrativeRoutes = daemonFactory
  .createApp()
  .get("/:workspaceId/narrative/:corpusName", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const corpusName = c.req.param("corpusName");

    const since = c.req.query("since");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;

    const corpusPath = path.join(getAtlasHome(), "memory", workspaceId, "narrative", corpusName);

    try {
      const corpus = new MdNarrativeCorpus({ workspaceRoot: corpusPath });
      const entries = await corpus.read({ since, limit });
      return c.json(entries);
    } catch (error: unknown) {
      logger.warn("memory narrative read failed, returning empty", {
        workspaceId,
        corpusName,
        error,
      });
      return c.json([]);
    }
  });
