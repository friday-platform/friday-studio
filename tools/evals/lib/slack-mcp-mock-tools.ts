import type { AtlasTools } from "@atlas/agent-sdk";
import { tool } from "ai";
import { z } from "zod";

export type SlackMockCounters = {
  conversations_history: number;
  conversations_replies: number;
  conversations_add_message: number;
  channels_list: number;
  users_list: number;
};

export function createSlackMCPMockTools(): { tools: AtlasTools; counters: SlackMockCounters } {
  const counters: SlackMockCounters = {
    conversations_history: 0,
    conversations_replies: 0,
    conversations_add_message: 0,
    channels_list: 0,
    users_list: 0,
  };

  // Realistic workspace fixtures
  const users = [
    { id: "U111", name: "john", realName: "John Doe" },
    { id: "U222", name: "maria", realName: "Maria Santos" },
    { id: "U333", name: "alex", realName: "Alex Kim" },
  ];

  const channels = [
    {
      id: "CENG",
      name: "engineering",
      topic: "Product engineering",
      purpose: "Daily eng work",
      memberCount: 42,
    },
    {
      id: "CPRD",
      name: "product",
      topic: "PM topics",
      purpose: "Roadmap & specs",
      memberCount: 18,
    },
    { id: "CREL", name: "releases", topic: "Release comms", purpose: "Ship logs", memberCount: 15 },
  ];

  const historyMessages = [
    {
      user: "maria",
      text: "Shipped v2.3.1 — improved Slack MCP stability and perf.",
      ts: "1725512040.00001",
    },
    {
      user: "john",
      text: "Please review PR #482: caching layer refactor.",
      ts: "1725510000.00002",
    },
    {
      user: "alex",
      text: "Blocker: flaky tests on CI, investigating mocks for network layer.",
      ts: "1725508800.00003",
    },
    {
      user: "maria",
      text: "Decision: postpone feature flag rollout to next sprint.",
      ts: "1725507000.00004",
    },
    {
      user: "john",
      text: "Action: add metrics for tool call latency by EOD.",
      ts: "1725505200.00005",
    },
  ];

  const threadMessages = [
    { user: "alex", text: "Thread: looking at retries config now.", ts: "1725512100.00010" },
    {
      user: "maria",
      text: "Thread: consider exponential backoff defaults.",
      ts: "1725512160.00011",
    },
  ];

  const tools: AtlasTools = {
    channels_list: tool({
      description: "List workspace channels",
      inputSchema: z.object({ query: z.string().optional() }),
      execute: ({ query }) => {
        counters.channels_list++;
        const data = query
          ? channels.filter((c) => c.name.includes(query.replace(/^[#@]/, "")))
          : channels;
        return { ok: true, channels: data };
      },
    }),

    users_list: tool({
      description: "List workspace users",
      inputSchema: z.object({ query: z.string().optional() }),
      execute: ({ query }) => {
        counters.users_list++;
        const data = query ? users.filter((u) => u.name.includes(query.replace(/^@/, ""))) : users;
        return { ok: true, users: data };
      },
    }),

    conversations_history: tool({
      description: "Fetch recent messages in a channel",
      inputSchema: z.object({
        channel: z.string().optional(),
        channel_id: z.string().optional(),
        limit: z.number().int().optional(),
        include_activity_messages: z.boolean().optional(),
      }),
      execute: () => {
        counters.conversations_history++;
        return { ok: true, messages: historyMessages };
      },
    }),

    conversations_replies: tool({
      description: "Fetch thread replies",
      inputSchema: z.object({ channel: z.string(), thread_ts: z.string() }),
      execute: () => {
        counters.conversations_replies++;
        return { ok: true, messages: threadMessages };
      },
    }),

    conversations_add_message: tool({
      description: "Post a message to a channel",
      inputSchema: z.object({
        channel: z.string(),
        text: z.string(),
        thread_ts: z.string().optional(),
      }),
      execute: () => {
        counters.conversations_add_message++;
        return { ok: true, ts: "1725514000.00003" };
      },
    }),
  };

  return { tools, counters };
}
