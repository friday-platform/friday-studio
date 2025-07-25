import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import { z } from "zod";

/**
 * Tavily web search and extraction tools
 * Based on https://docs.tavily.com/documentation/mcp
 */

export function registerTavilyTools(server: McpServer, ctx: ToolContext) {
  // Tavily Search Tool
  server.registerTool(
    "tavily_search",
    {
      description: "Search the web using Tavily's AI-powered search engine",
      inputSchema: {
        query: z.string().describe("The search query"),
        search_depth: z.enum(["basic", "advanced"]).default("basic").describe(
          "Search depth - basic or advanced",
        ),
        topic: z.enum(["general", "news"]).default("general").describe(
          "Search topic - general or news",
        ),
        days: z.number().optional().describe("Number of recent days to search (for news topic)"),
        max_results: z.number().min(1).max(20).default(5).describe(
          "Maximum number of results to return",
        ),
        include_domains: z.array(z.string()).optional().describe(
          "List of domains to include in search",
        ),
        exclude_domains: z.array(z.string()).optional().describe(
          "List of domains to exclude from search",
        ),
        include_answer: z.boolean().default(false).describe("Include AI-generated answer summary"),
        include_raw_content: z.boolean().default(false).describe("Include raw content from pages"),
        include_images: z.boolean().default(false).describe("Include images in search results"),
      },
    },
    async ({
      query,
      search_depth = "basic",
      topic = "general",
      days,
      max_results = 5,
      include_domains,
      exclude_domains,
      include_answer = false,
      include_raw_content = false,
      include_images = false,
    }) => {
      try {
        const apiKey = Deno.env.get("TAVILY_API_KEY");
        if (!apiKey) {
          throw new Error("TAVILY_API_KEY environment variable is required");
        }

        const searchParams: any = {
          query,
          search_depth,
          topic,
          max_results,
          include_answer,
          include_raw_content,
          include_images,
        };

        if (days && topic === "news") {
          searchParams.days = days;
        }

        if (include_domains?.length) {
          searchParams.include_domains = include_domains;
        }

        if (exclude_domains?.length) {
          searchParams.exclude_domains = exclude_domains;
        }

        const response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify(searchParams),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Tavily search failed: ${response.status} ${errorText}`);
        }

        const result = await response.json();

        return createSuccessResponse({
          query,
          answer: result.answer || null,
          results: result.results || [],
          images: result.images || [],
          follow_up_questions: result.follow_up_questions || [],
          response_time: result.response_time || 0,
          search_depth,
          topic,
        });
      } catch (error) {
        ctx.logger.error("Tavily search error", { error: (error as Error).message, query });
        throw new Error(`Search failed: ${(error as Error).message}`);
      }
    },
  );

  // Tavily Extract Tool
  server.registerTool(
    "tavily_extract",
    {
      description: "Extract content from specific URLs using Tavily",
      inputSchema: {
        urls: z.array(z.string().url()).describe("Array of URLs to extract content from"),
        include_images: z.boolean().default(false).describe("Include image URLs from pages"),
        include_favicon: z.boolean().default(false).describe("Include favicon URL"),
        extract_depth: z.enum(["basic", "advanced"]).default("basic").describe(
          "Extraction depth - basic or advanced",
        ),
        format: z.enum(["markdown", "text"]).default("markdown").describe(
          "Content format - markdown or text",
        ),
      },
    },
    async ({
      urls,
      include_images = false,
      include_favicon = false,
      extract_depth = "basic",
      format = "markdown",
    }) => {
      try {
        const apiKey = Deno.env.get("TAVILY_API_KEY");
        if (!apiKey) {
          throw new Error("TAVILY_API_KEY environment variable is required");
        }

        const response = await fetch("https://api.tavily.com/extract", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            urls,
            include_images,
            include_favicon,
            extract_depth,
            format,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Tavily extract failed: ${response.status} ${errorText}`);
        }

        const result = await response.json();

        return createSuccessResponse({
          results: result.results || [],
          failed_results: result.failed_results || [],
          response_time: result.response_time || 0,
        });
      } catch (error) {
        ctx.logger.error("Tavily extract error", { error: (error as Error).message, urls });
        throw new Error(`Extract failed: ${(error as Error).message}`);
      }
    },
  );

  // Tavily Crawl Tool
  server.registerTool(
    "tavily_crawl",
    {
      description: "Crawl a website and extract content using Tavily",
      inputSchema: {
        url: z.string().url().describe("The URL to crawl"),
        max_depth: z.number().min(1).max(3).default(1).describe("Maximum crawl depth"),
        exclude_domains: z.array(z.string()).optional().describe(
          "Domains to exclude from crawling",
        ),
        include_raw_content: z.boolean().default(true).describe(
          "Include raw content from crawled pages",
        ),
      },
    },
    async ({ url, max_depth = 1, exclude_domains, include_raw_content = true }) => {
      try {
        const apiKey = Deno.env.get("TAVILY_API_KEY");
        if (!apiKey) {
          throw new Error("TAVILY_API_KEY environment variable is required");
        }

        const crawlParams: any = {
          url,
          max_depth,
          include_raw_content,
        };

        if (exclude_domains?.length) {
          crawlParams.exclude_domains = exclude_domains;
        }

        const response = await fetch("https://api.tavily.com/crawl", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify(crawlParams),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Tavily crawl failed: ${response.status} ${errorText}`);
        }

        const result = await response.json();

        return createSuccessResponse({
          results: result.results || [],
          failed_urls: result.failed_urls || [],
          base_url: url,
          max_depth,
        });
      } catch (error) {
        ctx.logger.error("Tavily crawl error", { error: (error as Error).message, url });
        throw new Error(`Crawl failed: ${(error as Error).message}`);
      }
    },
  );
}
