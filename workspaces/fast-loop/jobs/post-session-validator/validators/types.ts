import { z } from "zod";

export const ValidationResultSchema = z.object({
  validator: z.string(),
  ok: z.boolean(),
  message: z.string(),
  evidence: z.array(z.string()),
});

export type ValidationResult = z.infer<typeof ValidationResultSchema>;
