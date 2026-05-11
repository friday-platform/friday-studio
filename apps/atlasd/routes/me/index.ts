import process from "node:process";
import { ONBOARDING_VERSION, UserStorage } from "@atlas/core/users/storage";
import type { Context } from "hono";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { getCurrentUser, updateCurrentUser } from "./adapter.ts";
import { deletePhoto, getPhoto, savePhoto, validatePhoto } from "./photo-storage.ts";

/** Derive the external-facing origin, respecting reverse-proxy headers. */
function getExternalOrigin(c: Context): string {
  const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? new URL(c.req.url).host;
  return `${proto}://${host}`;
}

const UpdateMeSchema = z.object({
  full_name: z.string().min(1).optional(),
  display_name: z.string().optional(),
  profile_photo: z.string().nullable().optional(),
  email: z.email().optional(),
  // IANA timezone strings ("America/New_York", "Europe/Berlin") have a
  // shape that's painful to schema; we trust browser-provided values
  // from `Intl.DateTimeFormat().resolvedOptions().timeZone`. Minimal
  // sanity gate: non-empty, no whitespace.
  timezone: z.string().min(1).regex(/^\S+$/).optional(),
  // BCP-47 locale tag — same trust-the-browser stance via
  // `navigator.language`. Loose-pattern guard against junk input.
  locale: z
    .string()
    .min(2)
    .max(35)
    .regex(/^[A-Za-z0-9-]+$/)
    .optional(),
});

/**
 * Required-fields contract: which keys the playground onboarding flow
 * MUST collect before letting the user dismiss the welcome page.
 * Local mode is permissive (the user already has a working session);
 * cloud and other future deployments tighten this list.
 */
function requiredOnboardingFields(): string[] {
  const env = process.env.FRIDAY_ENV ?? "dev";
  return env === "dev" ? [] : ["email"];
}

/**
 * /api/me - user identity and profile management.
 *
 * Identity is sourced via the request's `ctx.userId` (set by the
 * session middleware) — never by decoding FRIDAY_KEY.
 *
 * - Local (default): builds identity from `UserStorage.getUser(userId)`
 *   merged with `~/.atlas/profile.json` overrides.
 * - Remote (when PERSONA_URL is set): Fetches from persona service.
 *
 * Set USER_IDENTITY_ADAPTER=local to force local mode.
 */
const meRoutes = daemonFactory
  .createApp()
  .get("/", async (c) => {
    const result = await getCurrentUser(c.get("userId"));

    if (!result.ok) {
      return c.json({ error: result.error }, 503);
    }

    if (!result.data) {
      return c.json({ error: "User identity unavailable" }, 503);
    }

    const user = result.data;
    // Resolve relative profile_photo paths to absolute daemon URLs
    if (user.profile_photo?.startsWith("/")) {
      user.profile_photo = `${getExternalOrigin(c)}${user.profile_photo}`;
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

      const userId = c.get("userId");
      if (!userId) {
        return c.json({ error: "User identity unavailable" }, 503);
      }

      const data = await photoFile.arrayBuffer();
      await savePhoto(userId, data, validation.ext);

      // Set profile_photo to the full serving URL with a cache-busting param.
      // The ?v= changes on each upload so the browser fetches the new image,
      // while the serving endpoint can cache immutably.
      fields.profile_photo = `${getExternalOrigin(c)}/api/me/photo?v=${Date.now()}`;
    }

    // Handle explicit photo removal (profile_photo: null in fields)
    if (fields.profile_photo === null) {
      const userId = c.get("userId");
      if (userId) {
        await deletePhoto(userId);
      }
    }

    // Proxy field updates to persona (or local storage)
    const result = await updateCurrentUser(c.get("userId"), {
      full_name: fields.full_name,
      display_name: fields.display_name,
      profile_photo: fields.profile_photo,
      email: fields.email,
      timezone: fields.timezone,
      locale: fields.locale,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, 503);
    }

    if (!result.data) {
      return c.json({ error: "User identity unavailable" }, 503);
    }

    const updated = result.data;
    if (updated.profile_photo?.startsWith("/")) {
      updated.profile_photo = `${getExternalOrigin(c)}${updated.profile_photo}`;
    }

    return c.json({ user: updated });
  })
  .get("/photo", async (c) => {
    const userId = c.get("userId");
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
  })
  /**
   * GET /api/me/onboarding
   *
   * Returns the onboarding state the playground app-shell gates on:
   *   - `version`           — the onboarding-flow version the daemon
   *                           expects. Bumped when the wizard adds a
   *                           new step.
   *   - `completed`         — true iff the user has marked completion
   *                           at the current version.
   *   - `requiredFields`    — fields that MUST be populated before the
   *                           user can dismiss the welcome page.
   *                           Empty in local mode; `["email"]` in
   *                           cloud. The wizard surfaces a "skip"
   *                           affordance only when the array is empty.
   *   - `missingRequired`   — subset of `requiredFields` that are
   *                           still empty on the user record.
   */
  .get("/onboarding", async (c) => {
    const userId = c.get("userId");
    if (!userId) {
      return c.json({ error: "User identity unavailable" }, 503);
    }

    const stored = await UserStorage.getUser(userId);
    if (!stored.ok) return c.json({ error: stored.error }, 503);

    const record = stored.data;
    const completed = (record?.onboarding.version ?? 0) >= ONBOARDING_VERSION;
    const required = requiredOnboardingFields();
    const missingRequired = required.filter((field) => {
      // The identity record can hold `email`/`timezone`/`locale`.
      // Any other field in `required` would be a schema drift caught
      // at review time — we narrow to known keys here.
      if (field === "email") return !record?.identity.email;
      if (field === "timezone") return !record?.identity.timezone;
      if (field === "locale") return !record?.identity.locale;
      return true;
    });

    return c.json({
      version: ONBOARDING_VERSION,
      completed,
      requiredFields: required,
      missingRequired,
    });
  })
  /**
   * POST /api/me/onboarding/complete
   *
   * Mark onboarding done at the current ONBOARDING_VERSION. Idempotent
   * — subsequent calls with the same version are no-ops at the storage
   * layer. The playground hits this once at the end of the wizard
   * (and when the user clicks "Skip" if `requiredFields` is empty).
   */
  .post("/onboarding/complete", async (c) => {
    const userId = c.get("userId");
    if (!userId) {
      return c.json({ error: "User identity unavailable" }, 503);
    }

    // Enforce the required-fields contract on the server too — the
    // wizard hides the skip button when fields are missing, but a
    // direct POST shouldn't be able to bypass that gate.
    const required = requiredOnboardingFields();
    if (required.length > 0) {
      const stored = await UserStorage.getUser(userId);
      if (!stored.ok) return c.json({ error: stored.error }, 503);
      const identity = stored.data?.identity;
      const missing = required.filter((field) => {
        if (field === "email") return !identity?.email;
        if (field === "timezone") return !identity?.timezone;
        if (field === "locale") return !identity?.locale;
        return true;
      });
      if (missing.length > 0) {
        return c.json(
          { error: "Required onboarding fields are missing", missingRequired: missing },
          400,
        );
      }
    }

    const result = await UserStorage.markOnboardingComplete(userId, ONBOARDING_VERSION);
    if (!result.ok) return c.json({ error: result.error }, 503);
    return c.json({ version: ONBOARDING_VERSION, completed: true });
  });

export { meRoutes };
export type MeRoutes = typeof meRoutes;
export type { UserIdentity } from "./schemas.ts";
