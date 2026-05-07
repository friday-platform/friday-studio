#!/usr/bin/env -S deno run --allow-all
/**
 * Auth-free fake inbox MCP server for first-principles QA.
 *
 * Models the shape of a Gmail-style workload without OAuth/network:
 * search -> batch fetch -> mutate labels. Payloads are deterministic and
 * synthetic; no real user data.
 */
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.28/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@1.28/server/stdio.js";
import { z } from "npm:zod@4";

const server = new McpServer(
  { name: "fake-inbox", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

interface FakeMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  labels: string[];
}

function makeMessages(): FakeMessage[] {
  return Array.from({ length: 12 }, (_, idx) => {
    const n = idx + 1;
    const id = `fake-${String(n).padStart(3, "0")}`;
    const important = n % 4 === 0;
    const body = [
      `FIRST_PRINCIPLES_EMAIL_BODY ${id}`,
      important
        ? `Action required: synthetic project update ${n} needs a decision before EOD.`
        : `FYI newsletter-style synthetic update ${n}; safe to archive after review.`,
      // Deliberately verbose so action-output refs-over-data has something
      // meaningful to protect against. Still synthetic and deterministic.
      ...Array.from(
        { length: 10 },
        (__, i) =>
          `Line ${i + 1}: deterministic no-auth inbox fixture content for ${id}; refs-over-data regression sentinel.`,
      ),
    ].join("\n");
    return {
      id,
      from: important ? "alerts@example.test" : "newsletter@example.test",
      subject: important ? `Action required ${n}` : `Synthetic digest ${n}`,
      body,
      labels: ["inbox", "unread"],
    };
  });
}

const messages = makeMessages();

server.registerTool(
  "search_messages",
  {
    description: "Search synthetic inbox messages. Auth-free Gmail-shaped fixture.",
    inputSchema: { query: z.string().optional(), limit: z.number().optional() },
  },
  ({ limit }) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ids: messages.slice(0, limit ?? messages.length).map((m) => m.id) }),
      },
    ],
  }),
);

server.registerTool(
  "get_messages_content_batch",
  {
    description: "Fetch full synthetic message contents for a batch of ids.",
    inputSchema: { ids: z.array(z.string()) },
  },
  ({ ids }) => {
    const selected = messages.filter((m) => ids.includes(m.id));
    return { content: [{ type: "text" as const, text: JSON.stringify({ messages: selected }) }] };
  },
);

server.registerTool(
  "batch_modify_message_labels",
  {
    description: "Ack-only synthetic label mutation for fake inbox messages.",
    inputSchema: {
      ids: z.array(z.string()),
      addLabels: z.array(z.string()).optional(),
      removeLabels: z.array(z.string()).optional(),
    },
  },
  ({ ids, addLabels, removeLabels }) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: true,
          modifiedCount: ids.length,
          addLabels: addLabels ?? [],
          removeLabels: removeLabels ?? [],
        }),
      },
    ],
  }),
);

server.registerTool(
  "modify_message_labels",
  {
    description: "Ack-only synthetic single-message label mutation.",
    inputSchema: {
      id: z.string(),
      addLabels: z.array(z.string()).optional(),
      removeLabels: z.array(z.string()).optional(),
    },
  },
  ({ id, addLabels, removeLabels }) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: true,
          id,
          addLabels: addLabels ?? [],
          removeLabels: removeLabels ?? [],
        }),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
