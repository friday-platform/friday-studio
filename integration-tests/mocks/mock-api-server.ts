#!/usr/bin/env -S deno run --allow-all

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "mock-api-server",
  version: "1.0.0",
});

// In-memory storage for mock data
const users = new Map<string, any>();
const posts = new Map<string, any>();
const items = new Map<string, any>();

// Initialize with some test data
users.set("user-1", { id: "user-1", name: "Alice", email: "alice@example.com" });
users.set("user-2", { id: "user-2", name: "Bob", email: "bob@example.com" });
items.set("item-1", { id: "item-1", name: "Widget", price: 9.99 });
items.set("item-2", { id: "item-2", name: "Gadget", price: 19.99 });

// Register fetch_user tool
server.registerTool(
  "fetch_user",
  {
    description: "Fetch user data by ID",
    inputSchema: {
      userId: z.string().describe("User ID to fetch"),
    },
  },
  async ({ userId }) => {
    // Simulate async operation
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const user = users.get(userId);
    if (!user) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: "User not found" }) },
        ],
      };
    }
    
    return {
      content: [
        { type: "text", text: JSON.stringify(user) },
      ],
    };
  },
);

// Register create_post tool
server.registerTool(
  "create_post",
  {
    description: "Create a new post",
    inputSchema: {
      userId: z.string().describe("ID of the user creating the post"),
      title: z.string().describe("Post title"),
      content: z.string().describe("Post content"),
    },
  },
  async ({ userId, title, content }) => {
    // Simulate async operation
    await new Promise(resolve => setTimeout(resolve, 150));
    
    const postId = `post-${Date.now()}`;
    const post = {
      id: postId,
      userId,
      title,
      content,
      createdAt: new Date().toISOString(),
    };
    
    posts.set(postId, post);
    
    return {
      content: [
        { type: "text", text: JSON.stringify(post) },
      ],
    };
  },
);

// Register list_items tool
server.registerTool(
  "list_items",
  {
    description: "List available items with optional filtering",
    inputSchema: {
      maxPrice: z.number().optional().describe("Maximum price filter"),
      limit: z.number().default(10).describe("Maximum number of items to return"),
    },
  },
  async ({ maxPrice, limit = 10 }) => {
    // Simulate async operation
    await new Promise(resolve => setTimeout(resolve, 50));
    
    let itemList = Array.from(items.values());
    
    if (maxPrice !== undefined) {
      itemList = itemList.filter(item => item.price <= maxPrice);
    }
    
    itemList = itemList.slice(0, limit);
    
    return {
      content: [
        { type: "text", text: JSON.stringify({ items: itemList, total: itemList.length }) },
      ],
    };
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
console.error("Mock API MCP Server running on stdio");