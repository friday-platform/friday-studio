import { z } from "zod/v4";

/**
 * Shared Zod schemas for service platform managers
 */

// Port number validation with automatic fallback to 8080
export const portSchema = z.number().int().min(1).max(65535).catch(8080);

// Configuration and status schema with port (uses required + catch for auto-fallback)
export const portConfigSchema = z.object({ port: portSchema });
