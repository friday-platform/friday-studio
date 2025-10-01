import { z } from "zod";

// Base error cause schema - just metadata, no message
const BaseErrorCauseSchema = z.object({ code: z.string() });

// Network errors (connection issues, timeouts, daemon connectivity)
const NetworkErrorCauseSchema = BaseErrorCauseSchema.extend({
  type: z.literal("network"),
  statusCode: z.number().optional(),
  url: z.string().optional(),
  timeout: z.boolean().optional(),
});

// API errors (from AI providers, external services)
const APIErrorCauseSchema = BaseErrorCauseSchema.extend({
  type: z.literal("api"),
  statusCode: z.number(),
  url: z.string().optional(),
  isRetryable: z.boolean().optional(),
  retryAfter: z.number().optional(),
  providerMessage: z.string().optional(),
});

// Unknown/fallback errors
const UnknownErrorCauseSchema = BaseErrorCauseSchema.extend({
  type: z.literal("unknown"),
  originalError: z.string().optional(),
});

// Discriminated union of all error causes
export const ErrorCauseSchema = z.discriminatedUnion("type", [
  NetworkErrorCauseSchema,
  APIErrorCauseSchema,
  UnknownErrorCauseSchema,
]);

export type ErrorCause = z.infer<typeof ErrorCauseSchema>;
export type NetworkErrorCause = z.infer<typeof NetworkErrorCauseSchema>;
export type APIErrorCause = z.infer<typeof APIErrorCauseSchema>;
export type UnknownErrorCause = z.infer<typeof UnknownErrorCauseSchema>;
