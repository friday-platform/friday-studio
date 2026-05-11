/**
 * Stub Google MCP servers for OAuth refresh-resilience QA.
 *
 * The QA workspace (`tools/qa/fixtures/oauth-refresh-qa/workspace.yml`)
 * references two HTTP MCP servers at fixed ports — `google-calendar` on
 * 8001 and `google-gmail` on 8002. Friday's MCP client connects with a
 * Bearer access_token sourced from Link, so any request exercising a
 * Google tool flows through the credential-refresh path under test. The
 * MCP servers themselves only exist to provide the tool surface; they
 * don't validate the token, accept anything, and return synthetic data.
 *
 * Each server speaks the Streamable HTTP MCP transport via the SDK's
 * Web-Standards adapter (`WebStandardStreamableHTTPServerTransport`),
 * which fits Deno.serve naturally (Request in → Response out).
 *
 * Two-line entry point for callers:
 *
 *   const servers = await startStubMCPServers();
 *   await servers.stop();
 */
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.28/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.28/server/webStandardStreamableHttp.js";
import { z } from "npm:zod@4";

export type StubMCPKind = "calendar" | "gmail";

export interface StubMCPServerHandle {
  /** Base URL of the listening server (no path). */
  url: string;
  /** MCP endpoint URL (matches the workspace.yml `transport.url`). */
  mcpUrl: string;
  stop: () => Promise<void>;
}

export interface StubMCPServersHandle {
  calendar: StubMCPServerHandle;
  gmail: StubMCPServerHandle;
  stop: () => Promise<void>;
}

/**
 * Spin up one MCP server for the given Google sub-product. `port = 0`
 * picks an ephemeral port; the resulting `url` is returned. Each call
 * builds a fresh `McpServer` so two concurrent calendar stubs don't
 * share state — matters when a scenario wants to assert tool-call
 * counts on a specific server.
 */
export async function startStubMCPServer(
  kind: StubMCPKind,
  port: number,
): Promise<StubMCPServerHandle> {
  const server = buildMcpServer(kind);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless mode — each request stands alone. Friday's MCP client
    // sends the initialize on every request anyway because the transport
    // is HTTP, not stdio.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const controller = new AbortController();
  let listenPort = 0;
  const ready = new Promise<void>((resolve) => {
    Deno.serve(
      {
        port,
        hostname: "127.0.0.1",
        signal: controller.signal,
        onListen: ({ port: actual }) => {
          listenPort = actual;
          resolve();
        },
      },
      async (req) => {
        const url = new URL(req.url);
        if (url.pathname !== "/mcp") {
          return new Response("Not Found", { status: 404 });
        }
        return await transport.handleRequest(req);
      },
    );
  });
  await ready;

  const url = `http://127.0.0.1:${listenPort}`;
  return {
    url,
    mcpUrl: `${url}/mcp`,
    stop: async (): Promise<void> => {
      controller.abort();
      try {
        await transport.close();
      } catch {
        // best-effort
      }
      // Yield once so Deno.serve flushes the abort.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

/**
 * Convenience: spin up both servers in parallel on default ports
 * (calendar=8001, gmail=8002 — matching the QA workspace.yml). Pass
 * explicit ports to override; pass 0 for ephemeral when you don't
 * care which port lands.
 */
export async function startStubMCPServers(
  options: { calendarPort?: number; gmailPort?: number } = {},
): Promise<StubMCPServersHandle> {
  const [calendar, gmail] = await Promise.all([
    startStubMCPServer("calendar", options.calendarPort ?? 8001),
    startStubMCPServer("gmail", options.gmailPort ?? 8002),
  ]);
  return {
    calendar,
    gmail,
    stop: async (): Promise<void> => {
      await Promise.all([calendar.stop(), gmail.stop()]);
    },
  };
}

function buildMcpServer(kind: StubMCPKind): McpServer {
  const server = new McpServer(
    { name: `stub-google-${kind}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  if (kind === "calendar") {
    registerCalendarTools(server);
  } else {
    registerGmailTools(server);
  }
  return server;
}

function registerCalendarTools(server: McpServer): void {
  server.registerTool(
    "list_calendars",
    {
      description: "List the user's Google calendars. QA stub — returns synthetic data.",
      inputSchema: {},
    },
    () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            calendars: [
              { id: "qa-primary", summary: "QA Primary Calendar", primary: true, timeZone: "UTC" },
            ],
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "search_events",
    {
      description: "Search Google Calendar events. QA stub — returns synthetic data.",
      inputSchema: {
        calendarId: z.string().optional(),
        query: z.string().optional(),
        timeMin: z.string().optional(),
        timeMax: z.string().optional(),
      },
    },
    () => ({ content: [{ type: "text" as const, text: JSON.stringify({ events: [] }) }] }),
  );
}

function registerGmailTools(server: McpServer): void {
  server.registerTool(
    "search_gmail_messages",
    {
      description: "Search Gmail messages by query. QA stub — returns synthetic data.",
      inputSchema: { query: z.string().optional(), limit: z.number().optional() },
    },
    () => ({ content: [{ type: "text" as const, text: JSON.stringify({ messages: [] }) }] }),
  );

  server.registerTool(
    "get_gmail_message_content",
    {
      description: "Fetch a Gmail message by id. QA stub — returns synthetic data.",
      inputSchema: { id: z.string() },
    },
    ({ id }) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ message: { id, snippet: "QA stub message", body: "" } }),
        },
      ],
    }),
  );
}
