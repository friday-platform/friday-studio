import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { getCurrentUser, getCurrentUserId, updateCurrentUser } from "./adapter.ts";
import { deletePhoto, getPhoto, savePhoto, validatePhoto } from "./photo-storage.ts";

const UpdateMeSchema = z.object({
  full_name: z.string().min(1).optional(),
  display_name: z.string().optional(),
  profile_photo: z.string().nullable().optional(),
});

/**
 * /api/me - user identity and profile management.
 *
 * Uses adapter pattern for local/remote switching:
 * - Local (default when no PERSONA_URL): Extracts user from ATLAS_KEY JWT
 * - Remote (when PERSONA_URL is set): Fetches from persona service
 *
 * Set USER_IDENTITY_ADAPTER=local to force local mode.
 */
const meRoutes = daemonFactory
  .createApp()
  .get("/", async (c) => {
    const result = await getCurrentUser();

    if (!result.ok) {
      return c.json({ error: result.error }, 503);
    }

    if (!result.data) {
      return c.json({ error: "User identity unavailable" }, 503);
    }

    const user = result.data;
    // Resolve relative profile_photo paths to absolute daemon URLs
    if (user.profile_photo?.startsWith("/")) {
      user.profile_photo = `${new URL(c.req.url).origin}${user.profile_photo}`;
    }

    return c.json({ user });
  })
  .patch("/", async (c) => {
    const contentType = c.req.header("content-type") ?? "";

    let fields: z.infer<typeof UpdateMeSchema> = {};
    let photoFile: File | null = null;

    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();

      // Extract photo file if present
      const file = formData.get("photo");
      if (file instanceof File && file.size > 0) {
        photoFile = file;
      }

      // Extract JSON fields from "fields" part or individual form fields
      const fieldsRaw = formData.get("fields");
      if (typeof fieldsRaw === "string") {
        let json: unknown;
        try {
          json = JSON.parse(fieldsRaw);
        } catch {
          return c.json({ error: "Invalid JSON in fields" }, 400);
        }
        const parsed = UpdateMeSchema.safeParse(json);
        if (!parsed.success) {
          return c.json({ error: parsed.error.message }, 400);
        }
        fields = parsed.data;
      }
    } else {
      // JSON body
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }
      const parsed = UpdateMeSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: parsed.error.message }, 400);
      }
      fields = parsed.data;
    }

    // Handle photo upload
    if (photoFile) {
      const validation = validatePhoto(photoFile);
      if (!validation.valid) {
        return c.json({ error: validation.error }, 400);
      }

      const userId = await getCurrentUserId();
      if (!userId) {
        return c.json({ error: "User identity unavailable" }, 503);
      }

      const data = await photoFile.arrayBuffer();
      await savePhoto(userId, data, validation.ext);

      // Set profile_photo to the full serving URL with a cache-busting param.
      // The ?v= changes on each upload so the browser fetches the new image,
      // while the serving endpoint can cache immutably.
      const origin = new URL(c.req.url).origin;
      fields.profile_photo = `${origin}/api/me/photo?v=${Date.now()}`;
    }

    // Handle explicit photo removal (profile_photo: null in fields)
    if (fields.profile_photo === null) {
      const userId = await getCurrentUserId();
      if (userId) {
        await deletePhoto(userId);
      }
    }

    // Proxy field updates to persona (or local storage)
    const result = await updateCurrentUser({
      full_name: fields.full_name,
      display_name: fields.display_name,
      profile_photo: fields.profile_photo,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, 503);
    }

    if (!result.data) {
      return c.json({ error: "User identity unavailable" }, 503);
    }

    const updated = result.data;
    if (updated.profile_photo?.startsWith("/")) {
      updated.profile_photo = `${new URL(c.req.url).origin}${updated.profile_photo}`;
    }

    return c.json({ user: updated });
  })
  .get("/photo", async (c) => {
    const userId = await getCurrentUserId();
    if (!userId) {
      return c.json({ error: "User identity unavailable" }, 503);
    }

    const photo = await getPhoto(userId);
    if (!photo) {
      return c.json({ error: "No photo found" }, 404);
    }

    // Copy into a fresh ArrayBuffer to satisfy BodyInit typing
    const buf = new ArrayBuffer(photo.data.byteLength);
    new Uint8Array(buf).set(photo.data);
    return c.body(buf, 200, {
      "Content-Type": photo.contentType,
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });

export { meRoutes };
export type MeRoutes = typeof meRoutes;
export type { UserIdentity } from "./schemas.ts";
