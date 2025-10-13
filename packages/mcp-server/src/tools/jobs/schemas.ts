import { z } from "zod";

export const JobDirectParamsSchema = z.object({
  payload: z.record(z.string(), z.unknown()).default({}),
  streamId: z.string().optional(),
});

export type JobDirectParams = z.infer<typeof JobDirectParamsSchema>;
