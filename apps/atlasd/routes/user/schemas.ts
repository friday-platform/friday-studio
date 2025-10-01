import { z } from "zod";

export const userGetResponseSchema = z
  .object({ success: z.boolean(), user: z.string() })
  .meta({ description: "User get response" });

export const errorResponseSchema = z
  .object({ error: z.string() })
  .meta({ description: "Standard error response" });
