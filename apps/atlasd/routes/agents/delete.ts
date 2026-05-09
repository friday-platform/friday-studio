/**
 * DELETE /api/agents/:id — Remove a user agent from the registry.
 *
 * Removes the on-disk install dir(s) under {FRIDAY_HOME}/agents/{id}@{version}
 * and reloads the registry. Optional `version` query parameter scopes the
 * delete to a single version; without it, every version of the agent is
 * removed. Returns the list of paths that were deleted so callers can
 * confirm the action.
 *
 * Bundled and SDK-registered agents are not deletable via this route — they
 * live in code, not on disk. Returns 400 if the id resolves to a non-user
 * agent.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";

const DeleteAgentQuerySchema = z.object({ version: z.string().min(1).optional() });
const DeleteAgentParamsSchema = z.object({ id: z.string().min(1) });

const deleteAgentRoute = daemonFactory.createApp();

deleteAgentRoute.delete("/:id", async (c) => {
  const paramParse = DeleteAgentParamsSchema.safeParse(c.req.param());
  if (!paramParse.success) {
    return c.json({ ok: false as const, error: "Agent id is required" }, 400);
  }
  const { id } = paramParse.data;

  const queryParse = DeleteAgentQuerySchema.safeParse(c.req.query());
  if (!queryParse.success) {
    return c.json({ ok: false as const, error: "Invalid version query" }, 400);
  }
  const { version } = queryParse.data;

  const registry = c.get("app").getAgentRegistry();
  const summary = registry.getUserAgentSummary(id);
  if (!summary) {
    const agent = await registry.getAgent(id);
    if (agent) {
      return c.json(
        {
          ok: false as const,
          error: `Agent "${id}" is not a user agent — bundled and SDK agents cannot be deleted via this endpoint.`,
        },
        400,
      );
    }
    return c.json(
      { ok: false as const, error: `Agent "${id}" is not registered.`, deleted: [] as string[] },
      404,
    );
  }

  const agentsDir = join(getFridayHome(), "agents");
  const targets: string[] = [];

  if (version) {
    targets.push(join(agentsDir, `${id}@${version}`));
  } else {
    let entries: string[];
    try {
      entries = await readdir(agentsDir);
    } catch (error) {
      return c.json(
        { ok: false as const, error: `Failed to scan agents dir: ${stringifyError(error)}` },
        500,
      );
    }
    const prefix = `${id}@`;
    for (const entry of entries) {
      if (entry.startsWith(prefix)) targets.push(join(agentsDir, entry));
    }
    if (targets.length === 0) {
      return c.json(
        {
          ok: false as const,
          error: `No on-disk artifacts found for agent "${id}".`,
          deleted: [] as string[],
        },
        404,
      );
    }
  }

  const deleted: string[] = [];
  for (const target of targets) {
    try {
      const info = await stat(target);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      await rm(target, { recursive: true, force: true });
      deleted.push(target);
    } catch (error) {
      return c.json(
        {
          ok: false as const,
          error: `Failed to delete ${target}: ${stringifyError(error)}`,
          deleted,
        },
        500,
      );
    }
  }

  if (deleted.length === 0) {
    return c.json(
      {
        ok: false as const,
        error: version
          ? `No artifact at ${join(agentsDir, `${id}@${version}`)}.`
          : `No on-disk artifacts found for agent "${id}".`,
        deleted,
      },
      404,
    );
  }

  await registry.reload();
  return c.json({ ok: true as const, agent: { id, deleted } });
});

export { deleteAgentRoute };
