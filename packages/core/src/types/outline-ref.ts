/**
 * OutlineRef Schema and Types
 *
 * Standardized schema for outline updates from agents.
 * Used when agents return structured references to external services
 * or internal tool results that should be displayed in the outline.
 */

import { z } from "zod";

/**
 * Schema for individual outline references from agent tool calls
 *
 * @property service - The service identifier ('google-calendar', 'slack', 'email', or 'internal')
 * @property title - Display title for the reference (e.g., 'Calendar retrieved')
 * @property content - Optional summary text
 * @property artifactId - Optional associated artifact ID
 * @property artifactLabel - Optional label for the artifact
 * @property type - Optional type discriminator
 */
export const OutlineRefSchema = z.object({
  service: z.string(),
  title: z.string(),
  content: z.string().optional(),
  artifactId: z.string().optional(),
  artifactLabel: z.string().optional(),
  type: z.string().optional(),
});

export type OutlineRef = z.infer<typeof OutlineRefSchema>;

/**
 * Schema for parsing tool results that may contain outline references
 * Uses passthrough to allow additional fields from tool results
 */
export const OutlineRefsResultSchema = z
  .object({ outlineRefs: z.array(OutlineRefSchema).optional() })
  .passthrough();

export type OutlineRefsResult = z.infer<typeof OutlineRefsResultSchema>;
