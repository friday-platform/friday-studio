/**
 * Transport-correct env routing for MCP registry installs.
 *
 * Two orthogonal rules live here. Both apply at every install path — the
 * registry fast path and the doctor-extracted path alike.
 *
 * - **Need rule** (`routeEnvVars`): which env vars are credentials. A var that
 *   is required — regardless of its secret flag — or any var marked secret is
 *   treated as a credential and becomes a Link ref. Registry authors are
 *   unreliable about `isSecret`, so "required" alone earns credential handling.
 *   Whatever is left (optional + non-secret) becomes a plain string carrying
 *   its upstream default.
 * - **Sink rule** (`envSink`): which `MCPServerConfig` field a transport reads
 *   its env block from at spawn. A stdio server and a sidecar-less HTTP server
 *   are read from `env`; an HTTP server with a `startup` sidecar is read from
 *   `startup.env`. Routing a value to the sink the runtime never consults is a
 *   silent drop.
 *
 * @module
 */

import type { LinkCredentialRef } from "@atlas/agent-sdk";
import type { RequiredConfigField } from "./schemas.ts";

/**
 * The minimal shape `routeEnvVars` needs from an env var. Satisfied by both
 * upstream registry-declared env vars (`UpstreamEnvironmentVariable`) and
 * doctor-extracted ones (`DoctorEnvVar`), so the same routing applies to every
 * install path.
 */
export interface RoutableEnvVar {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  placeholder?: string;
}

/** The `MCPServerConfig` field a transport reads its env block from at spawn. */
export type EnvSink = "server" | "startup";

/** Outcome of routing a set of env vars by the need rule. */
export interface RoutedEnv {
  /**
   * The env block: Link refs for credential vars (required, or any secret),
   * plain strings for optional non-secret vars (carrying the upstream default,
   * empty string when there is none). Belongs in the sink `envSink` selects.
   */
  env: Record<string, string | LinkCredentialRef>;
  /**
   * Subset of input `envVars` routed to Link — these, and only these, become the
   * Link provider's `secretSchema` fields. Carries the full `RoutableEnvVar`
   * objects so downstream consumers (e.g. the Link provider builder) can read
   * `isRequired`, `isSecret`, `description`, and `placeholder` metadata. Empty
   * when nothing needs a credential.
   */
  linkVars: RoutableEnvVar[];
  /** Descriptors for the required vars — what the user must supply at install. */
  requiredConfig: RequiredConfigField[];
}

/**
 * Route env vars by need. Credential vars (required, or any secret) become Link
 * refs pointing at `providerId`; optional non-secret vars become plain strings
 * carrying their upstream `default` (empty string when absent).
 */
export function routeEnvVars(envVars: RoutableEnvVar[], providerId: string): RoutedEnv {
  const env: Record<string, string | LinkCredentialRef> = {};
  const linkVars: RoutableEnvVar[] = [];
  const requiredConfig: RequiredConfigField[] = [];

  for (const ev of envVars) {
    const isRequired = ev.isRequired ?? false;
    const isSecret = ev.isSecret ?? false;

    if (isRequired || isSecret) {
      env[ev.name] = { from: "link", provider: providerId, key: ev.name };
      linkVars.push(ev);
    } else {
      env[ev.name] = ev.default ?? "";
    }

    if (isRequired) {
      let description = ev.description ?? ev.name;
      if (ev.placeholder) {
        description = `${description} (e.g. ${ev.placeholder})`;
      }
      const field: RequiredConfigField = { key: ev.name, description, type: "string" };
      if (ev.default !== undefined) {
        field.examples = [ev.default];
      }
      requiredConfig.push(field);
    }
  }

  return { env, linkVars, requiredConfig };
}

/** Outcome of lifting literal env values out of a config template's env block. */
export interface SplitLiteralEnv {
  /**
   * The env block with literal plain-string values replaced by the
   * `from_environment` wiring magic string. Link refs and magic strings
   * (`from_environment` / `auto`) pass through untouched.
   */
  wiring: Record<string, string | LinkCredentialRef>;
  /**
   * The literal values lifted out, keyed by env var name — to be written to
   * the workspace `.env`. Empty-string literals carry no value and are
   * omitted: the var is still wired, the user supplies the value later.
   */
  values: Record<string, string>;
}

/**
 * Lift literal plain-string env values out of a config template's env block.
 *
 * The registry translator writes optional non-secret env vars as literal
 * strings (their upstream default) directly into `configTemplate.env`. On
 * enable into a workspace, those values belong in the workspace `.env` — the
 * single store the settings UI edits — while the config copy holds only
 * `from_environment` wiring. This splits the two: literals become `values`
 * plus `from_environment` wiring; Link refs and existing magic strings pass
 * through unchanged.
 */
export function splitLiteralEnvValues(
  env: Record<string, string | LinkCredentialRef>,
): SplitLiteralEnv {
  const wiring: Record<string, string | LinkCredentialRef> = {};
  const values: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      wiring[key] = value; // Link ref — untouched.
      continue;
    }
    if (value === "from_environment" || value === "auto") {
      wiring[key] = value; // Already wiring — untouched.
      continue;
    }
    // Literal value — lift it to the `.env`, leave `from_environment` behind.
    wiring[key] = "from_environment";
    if (value.length > 0) {
      values[key] = value;
    }
  }

  return { wiring, values };
}

/**
 * Select the config field a server's transport reads its env block from.
 *
 * `connectStdio` passes `config.env` straight into the stdio subprocess;
 * `connectHttp` passes `config.startup.env` into the sidecar subprocess and
 * reads `config.env` only for bearer-auth headers. A sidecar-less HTTP server
 * spawns nothing, so `config.env` is its only env block.
 */
export function envSink(transport: { type: string; hasStartup: boolean }): EnvSink {
  return transport.type === "http" && transport.hasStartup ? "startup" : "server";
}
