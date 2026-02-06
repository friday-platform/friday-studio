import { SkillStorage } from "@atlas/skills";
import { CreateSkillInputSchema } from "@atlas/skills/schemas";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";
import { getCurrentUser } from "./me/adapter.ts";

export const skillsRoutes = daemonFactory
  .createApp()
  .get("/:workspaceId", zValidator("param", z.object({ workspaceId: z.string() })), async (c) => {
    const result = await SkillStorage.list(c.req.valid("param").workspaceId);
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ skills: result.data });
  })
  .get(
    "/:workspaceId/:name",
    zValidator("param", z.object({ workspaceId: z.string(), name: z.string() })),
    async (c) => {
      const { workspaceId, name } = c.req.valid("param");
      const result = await SkillStorage.getByName(name, workspaceId);
      if (!result.ok) return c.json({ error: result.error }, 500);
      if (!result.data) return c.json({ error: "Skill not found" }, 404);
      return c.json({ skill: result.data });
    },
  )
  .post("/", zValidator("json", CreateSkillInputSchema), async (c) => {
    const userResult = await getCurrentUser();
    if (!userResult.ok || !userResult.data) return c.json({ error: "Unauthorized" }, 401);
    const result = await SkillStorage.create(userResult.data.id, c.req.valid("json"));
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ skill: result.data }, 201);
  })
  .patch(
    "/:id",
    zValidator("param", z.object({ id: z.string() })),
    zValidator("json", CreateSkillInputSchema.partial()),
    async (c) => {
      const userResult = await getCurrentUser();
      if (!userResult.ok || !userResult.data) return c.json({ error: "Unauthorized" }, 401);
      const result = await SkillStorage.update(c.req.valid("param").id, c.req.valid("json"));
      if (!result.ok) {
        if (result.error === "Skill not found") return c.json({ error: result.error }, 404);
        return c.json({ error: result.error }, 500);
      }
      return c.json({ skill: result.data });
    },
  )
  .delete("/:id", zValidator("param", z.object({ id: z.string() })), async (c) => {
    const userResult = await getCurrentUser();
    if (!userResult.ok || !userResult.data) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.valid("param").id;
    // Check existence first - SQLite DELETE is idempotent and won't fail for missing rows
    const existing = await SkillStorage.get(id);
    if (!existing.ok) return c.json({ error: existing.error }, 500);
    if (!existing.data) return c.json({ error: "Skill not found" }, 404);
    const result = await SkillStorage.delete(id);
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ success: true });
  });
