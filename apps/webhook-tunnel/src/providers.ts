/**
 * Config-driven webhook payload transformers.
 *
 * Reads webhook-mappings.yml to determine:
 *   1. Which events/actions to accept per provider
 *   2. How to extract signal payload fields from the webhook body
 *   3. Which header to check for event type and signature
 */

import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { logger } from "@atlas/logger";
import { parse as parseYaml } from "@std/yaml";
import type { Context } from "hono";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransformResult {
  payload: Record<string, unknown>;
  description: string;
}

const EventMappingSchema = z.object({
  actions: z.array(z.string()).optional(),
  mapping: z.record(z.string(), z.string()),
});

const ProviderConfigSchema = z.object({
  event_header: z.string().optional(),
  event_field: z.string().optional(),
  signature_header: z.string(),
  events: z.record(z.string(), EventMappingSchema),
});

const MappingsConfigSchema = z.object({ providers: z.record(z.string(), ProviderConfigSchema) });

type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
type MappingsConfig = z.infer<typeof MappingsConfigSchema>;

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAPPINGS_PATH =
  process.env.WEBHOOK_MAPPINGS_PATH ?? join(__dirname, "..", "webhook-mappings.yml");

let cachedConfig: MappingsConfig | undefined;

function loadMappings(): MappingsConfig {
  if (cachedConfig) return cachedConfig;

  const raw = readFileSync(MAPPINGS_PATH, "utf-8");
  cachedConfig = MappingsConfigSchema.parse(parseYaml(raw));
  return cachedConfig;
}

// ---------------------------------------------------------------------------
// Dot-path extraction
// ---------------------------------------------------------------------------

/**
 * Extract a value from a nested object using dot-path notation.
 *
 * Supports:
 *   - "pull_request.html_url" → obj.pull_request.html_url
 *   - "push.changes[0].new.name" → obj.push.changes[0].new.name
 */
function extractByPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;

  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;

    // Handle array index notation: "changes[0]"
    const arrayMatch = segment.match(/^([^[]+)\[(\d+)]$/);
    if (arrayMatch) {
      const key = arrayMatch[1] ?? "";
      const index = Number(arrayMatch[2] ?? "0");
      current = (current as Record<string, unknown>)[key];
      if (!Array.isArray(current)) return undefined;
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }

  return current;
}

// ---------------------------------------------------------------------------
// Provider handler (config-driven)
// ---------------------------------------------------------------------------

function createProviderHandler(name: string, config: ProviderConfig) {
  return {
    async verify(c: Context, secret: string | undefined): Promise<string | null> {
      if (!secret) return null;
      if (!config.signature_header) return null;

      const signature = c.req.header(config.signature_header);
      if (!signature) return `Missing ${config.signature_header} header`;

      const body = await c.req.text();
      const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        return "Invalid signature";
      }

      return null;
    },

    async transform(c: Context): Promise<TransformResult | null> {
      const body = await c.req.json();

      // Resolve event key from header or body field
      const eventKey = config.event_header
        ? c.req.header(config.event_header)
        : config.event_field
          ? String(extractByPath(body, config.event_field) ?? "")
          : undefined;

      if (!eventKey) return null;

      // Find matching event config
      const eventConfig = config.events[eventKey];
      if (!eventConfig) {
        logger.debug("Event not configured", { provider: name, event: eventKey });
        return null;
      }

      // Check action filter (GitHub-style)
      if (eventConfig.actions) {
        const action = body.action;
        if (!eventConfig.actions.includes(action)) {
          logger.debug("Action filtered", { provider: name, event: eventKey, action });
          return null;
        }
      }

      // Extract fields using dot-path mapping
      const payload: Record<string, unknown> = {};
      for (const [outputField, sourcePath] of Object.entries(eventConfig.mapping)) {
        const value = extractByPath(body, sourcePath);
        if (value !== undefined) {
          payload[outputField] = value;
        }
      }

      // Build description from first string field
      const firstValue = Object.values(payload).find((v) => typeof v === "string");
      const action = body.action ? ` ${body.action}` : "";
      const description = `${name} ${eventKey}${action}: ${firstValue ?? ""}`;

      return { payload, description };
    },
  };
}

// ---------------------------------------------------------------------------
// Raw passthrough provider (not config-driven)
// ---------------------------------------------------------------------------

const rawHandler = {
  verify(): Promise<string | null> {
    return Promise.resolve(null);
  },

  async transform(c: Context): Promise<TransformResult | null> {
    const body = await c.req.json();
    return { payload: body, description: "Raw webhook forwarded" };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ProviderHandler {
  verify: (c: Context, secret: string | undefined) => Promise<string | null>;
  transform: (c: Context) => Promise<TransformResult | null>;
}

let handlers: Record<string, ProviderHandler> | undefined;

function ensureHandlers(): Record<string, ProviderHandler> {
  if (handlers) return handlers;

  const mappings = loadMappings();
  handlers = { raw: rawHandler };

  for (const [name, config] of Object.entries(mappings.providers)) {
    handlers[name] = createProviderHandler(name, config);
  }

  return handlers;
}

export function getProvider(name: string): ProviderHandler | undefined {
  return ensureHandlers()[name];
}

export function listProviders(): string[] {
  return Object.keys(ensureHandlers());
}
