import { tool } from "ai";
import { z } from "zod";

export const FailInputSchema = z.object({
  reason: z.string().describe("Why the task cannot be completed"),
});

export type FailInput = z.infer<typeof FailInputSchema>;

export interface CreateFailToolOptions {
  onFail: (input: FailInput) => void;
  description?: string;
}

export function createFailTool(options: CreateFailToolOptions) {
  return tool({
    description:
      options.description ??
      "Signal that you cannot complete this task. Use when you lack required information, encounter an unrecoverable error, or the task is impossible.",
    inputSchema: FailInputSchema,
    execute: (input: FailInput) => {
      options.onFail(input);
      return { failed: true, reason: input.reason };
    },
  });
}
