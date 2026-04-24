/**
 * Builds an AgentContext backed by NATS capability subjects.
 * Mirrors the Python SDK's _context.py build_context() function.
 * @module
 */

import type { NatsConnection } from "nats";
import { StringCodec } from "nats";
import type { AgentContext, SessionData, ToolDefinition } from "./types.ts";

const sc = StringCodec();

const LLM_TIMEOUT_MS = 120_000;
const HTTP_TIMEOUT_MS = 60_000;
const TOOLS_CALL_TIMEOUT_MS = 60_000;
const TOOLS_LIST_TIMEOUT_MS = 10_000;

export function buildContext(
  raw: Record<string, unknown>,
  nc: NatsConnection,
  sessionId: string,
): AgentContext {
  const sessionRaw = raw.session;
  const session: SessionData =
    typeof sessionRaw === "object" && sessionRaw !== null
      ? {
          id: String((sessionRaw as Record<string, unknown>).id ?? ""),
          workspaceId: String((sessionRaw as Record<string, unknown>).workspace_id ?? ""),
          userId: String((sessionRaw as Record<string, unknown>).user_id ?? ""),
          datetime: String((sessionRaw as Record<string, unknown>).datetime ?? ""),
        }
      : { id: sessionId, workspaceId: "", userId: "", datetime: "" };

  const env: Record<string, string> = {};
  const envRaw = raw.env;
  if (typeof envRaw === "object" && envRaw !== null) {
    for (const [k, v] of Object.entries(envRaw)) {
      env[k] = String(v);
    }
  }

  const config: Record<string, unknown> =
    typeof raw.config === "object" && raw.config !== null
      ? (raw.config as Record<string, unknown>)
      : {};

  return {
    env,
    config,
    session,
    llm: {
      async generate(request) {
        const resp = await nc.request(
          `caps.${sessionId}.llm.generate`,
          sc.encode(JSON.stringify(request)),
          { timeout: LLM_TIMEOUT_MS },
        );
        const data = JSON.parse(sc.decode(resp.data)) as Record<string, unknown>;
        if ("error" in data) {
          throw new Error(String(data.error));
        }
        return data;
      },
    },
    http: {
      async fetch(request) {
        const resp = await nc.request(
          `caps.${sessionId}.http.fetch`,
          sc.encode(JSON.stringify(request)),
          { timeout: HTTP_TIMEOUT_MS },
        );
        const data = JSON.parse(sc.decode(resp.data)) as Record<string, unknown>;
        if ("error" in data) {
          throw new Error(String(data.error));
        }
        return data;
      },
    },
    tools: {
      async call(name, args) {
        const resp = await nc.request(
          `caps.${sessionId}.tools.call`,
          sc.encode(JSON.stringify({ name, args })),
          { timeout: TOOLS_CALL_TIMEOUT_MS },
        );
        const data = JSON.parse(sc.decode(resp.data)) as Record<string, unknown>;
        if ("error" in data) {
          throw new Error(String(data.error));
        }
        return data;
      },
      async list() {
        const resp = await nc.request(`caps.${sessionId}.tools.list`, sc.encode("{}"), {
          timeout: TOOLS_LIST_TIMEOUT_MS,
        });
        const data = JSON.parse(sc.decode(resp.data)) as Record<string, unknown>;
        if ("error" in data || !Array.isArray(data.tools)) {
          return [];
        }
        return (data.tools as Array<Record<string, unknown>>).map(
          (t): ToolDefinition => ({
            name: String(t.name ?? ""),
            description: String(t.description ?? ""),
            inputSchema: t.inputSchema ?? {},
          }),
        );
      },
    },
    stream: {
      emit(eventType, payload) {
        const chunk = JSON.stringify({ type: eventType, data: payload });
        nc.publish(`sessions.${sessionId}.events`, sc.encode(chunk));
      },
    },
  };
}
