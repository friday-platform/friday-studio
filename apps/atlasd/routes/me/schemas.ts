import { z } from "zod";

/**
 * User identity as returned by the /api/me endpoint.
 *
 * Mirrors persona service MeResponse struct. Fields are intentionally
 * flat (no nested objects) for simpler consumption in system prompts.
 */
export const UserIdentitySchema = z.object({
  id: z.string().meta({ description: "Unique user identifier (opaque string)" }),
  full_name: z.string().meta({ description: "User's full legal/display name" }),
  email: z.email().meta({ description: "Primary email address" }),
  created_at: z.iso.datetime().meta({ description: "Account creation timestamp (ISO 8601)" }),
  updated_at: z.iso.datetime().meta({ description: "Last profile update (ISO 8601)" }),
  display_name: z
    .string()
    .nullable()
    .meta({ description: "Preferred display name, may differ from full_name" }),
  profile_photo: z
    .string()
    .nullable()
    .meta({ description: "Profile photo URL or relative path, null if not set" }),
  usage: z
    .number()
    .min(0)
    .max(1)
    .meta({ description: "LLM budget usage ratio (spend/max_budget), 0 when unavailable" }),
});

export type UserIdentity = z.infer<typeof UserIdentitySchema>;
