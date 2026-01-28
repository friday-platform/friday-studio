import { z } from "zod";

const GitHubInstallationAccountSchema = z.object({
  login: z.string(),
  id: z.number(),
  type: z.enum(["Organization", "User"]),
});

export const GitHubInstallationSchema = z.object({
  id: z.number(),
  account: GitHubInstallationAccountSchema,
  app_id: z.number(),
  target_type: z.enum(["Organization", "User"]),
});

export const GitHubUserInstallationsResponseSchema = z.object({
  total_count: z.number(),
  installations: z.array(GitHubInstallationSchema),
});
