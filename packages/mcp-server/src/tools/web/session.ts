import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";
import { webSessionManager } from "./session-manager.ts";

export function registerWebSessionTools(server: McpServer, ctx: ToolContext) {
  // Create web session
  server.registerTool(
    "web_session_create",
    {
      description: `Creates a persistent web browser session for multi-step automation
      
- Creates a new browser session that persists across multiple operations
- Maintains cookies, local storage, and navigation history
- Supports custom user agent, viewport, and locale settings
- Sessions auto-expire after 30 minutes of inactivity
- Use this before navigating to sites that require cookie consent or multi-step flows`,
      inputSchema: {
        sessionId: z.string().describe("Unique identifier for the session"),
        userAgent: z.string().optional().describe("Custom user agent string"),
        viewport: z.object({
          width: z.number(),
          height: z.number(),
        }).optional().describe("Browser viewport size (default: 1920x1080)"),
        locale: z.string().optional().describe("Browser locale (default: en-US)"),
      },
    },
    async (params) => {
      try {
        ctx.logger.info("Creating web session", {
          sessionId: params.sessionId,
          operation: "web_session_create_start",
        });

        await webSessionManager.createSession(params.sessionId, {
          userAgent: params.userAgent,
          viewport: params.viewport,
          locale: params.locale,
        });

        ctx.logger.info("Web session created successfully", {
          sessionId: params.sessionId,
          operation: "web_session_create_success",
        });

        return createSuccessResponse({
          output: `Web session '${params.sessionId}' created successfully`,
          title: "Session Created",
          metadata: { sessionId: params.sessionId },
        });
      } catch (error) {
        ctx.logger.error("Failed to create web session", {
          sessionId: params.sessionId,
          error: error instanceof Error ? error.message : String(error),
          operation: "web_session_create_error",
        });
        throw error;
      }
    },
  );

  // Navigate to URL
  server.registerTool(
    "web_session_navigate",
    {
      description: `Navigates to a URL in an existing web session
      
- Navigates to the specified URL and waits for page load
- Maintains session state (cookies, local storage)
- Returns page title and final URL after redirects
- Supports wait conditions for page stability`,
      inputSchema: {
        sessionId: z.string().describe("Session identifier"),
        url: z.string().url().describe("URL to navigate to"),
        waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional()
          .describe("Wait condition (default: networkidle)"),
        timeout: z.number().optional().describe("Navigation timeout in seconds (default: 30)"),
      },
    },
    async (params) => {
      try {
        const session = webSessionManager.getSession(params.sessionId);
        if (!session) {
          throw new Error(
            `Session '${params.sessionId}' not found. Create it first with web_session_create.`,
          );
        }

        ctx.logger.info("Navigating in web session", {
          sessionId: params.sessionId,
          url: params.url,
          operation: "web_session_navigate_start",
        });

        const response = await session.page.goto(params.url, {
          waitUntil: params.waitUntil || "networkidle",
          timeout: (params.timeout || 30) * 1000,
        });

        const title = await session.page.title();
        const finalUrl = session.page.url();

        ctx.logger.info("Navigation completed", {
          sessionId: params.sessionId,
          url: params.url,
          finalUrl,
          title,
          status: response?.status(),
          operation: "web_session_navigate_success",
        });

        return createSuccessResponse({
          output: `Navigated to: ${finalUrl}\nTitle: ${title}\nStatus: ${
            response?.status() || "unknown"
          }`,
          title: "Navigation Complete",
          metadata: {
            sessionId: params.sessionId,
            url: finalUrl,
            title,
            status: response?.status(),
          },
        });
      } catch (error) {
        ctx.logger.error("Navigation failed", {
          sessionId: params.sessionId,
          url: params.url,
          error: error instanceof Error ? error.message : String(error),
          operation: "web_session_navigate_error",
        });
        throw error;
      }
    },
  );

  // Extract content from current page
  server.registerTool(
    "web_session_extract",
    {
      description: `Extracts content from the current page in a web session
      
- Extracts content in text, markdown, or HTML format
- Works with the current page state after navigation and interactions
- Supports CSS selector-based extraction for specific elements
- Returns clean, formatted content suitable for LLM processing`,
      inputSchema: {
        sessionId: z.string().describe("Session identifier"),
        format: z.enum(["text", "markdown", "html"]).describe("Output format"),
        selector: z.string().optional().describe(
          "CSS selector to extract specific elements (optional)",
        ),
      },
    },
    async (params) => {
      try {
        const session = webSessionManager.getSession(params.sessionId);
        if (!session) {
          throw new Error(`Session '${params.sessionId}' not found`);
        }

        ctx.logger.info("Extracting content from web session", {
          sessionId: params.sessionId,
          format: params.format,
          selector: params.selector,
          operation: "web_session_extract_start",
        });

        let content: string;
        let title: string;

        if (params.selector) {
          // Extract specific elements
          const elements = await session.page.$$(params.selector);
          if (elements.length === 0) {
            throw new Error(`No elements found for selector: ${params.selector}`);
          }

          if (params.format === "html") {
            const htmls = await Promise.all(elements.map((el) => el.innerHTML()));
            content = htmls.join("\n\n");
          } else {
            const texts = await Promise.all(elements.map((el) => el.textContent()));
            content = texts.filter((text) => text?.trim()).join("\n\n");
          }
          title = `Selected content (${elements.length} elements)`;
        } else {
          // Extract full page content
          title = await session.page.title();

          if (params.format === "html") {
            content = await session.page.content();
          } else if (params.format === "markdown") {
            // Get clean HTML first, then convert to markdown
            const html = await session.page.content();
            content = convertHTMLToMarkdown(html);
          } else {
            // Extract text content
            content = await session.page.evaluate(() => {
              // Remove script and style elements
              const scripts = document.querySelectorAll("script, style, noscript");
              scripts.forEach((el) => el.remove());

              return document.body.innerText || document.body.textContent || "";
            });
          }
        }

        const url = session.page.url();

        ctx.logger.info("Content extraction completed", {
          sessionId: params.sessionId,
          format: params.format,
          contentLength: content.length,
          operation: "web_session_extract_success",
        });

        return createSuccessResponse({
          output: content,
          title: `${title} - ${url}`,
          metadata: {
            sessionId: params.sessionId,
            url,
            format: params.format,
            selector: params.selector,
          },
        });
      } catch (error) {
        ctx.logger.error("Content extraction failed", {
          sessionId: params.sessionId,
          error: error instanceof Error ? error.message : String(error),
          operation: "web_session_extract_error",
        });
        throw error;
      }
    },
  );

  // Click element
  server.registerTool(
    "web_session_click",
    {
      description: `Clicks an element in the web session
      
- Clicks elements by CSS selector, text content, or accessibility attributes
- Waits for element to be visible and clickable before clicking
- Supports different click types (left, right, double)
- Returns confirmation of click action and any navigation that occurred`,
      inputSchema: {
        sessionId: z.string().describe("Session identifier"),
        selector: z.string().optional().describe("CSS selector for the element"),
        text: z.string().optional().describe("Text content to click (partial match)"),
        role: z.string().optional().describe("ARIA role of element to click"),
        button: z.enum(["left", "right", "middle"]).optional().describe(
          "Mouse button (default: left)",
        ),
        clickCount: z.number().optional().describe("Number of clicks (default: 1)"),
        timeout: z.number().optional().describe("Timeout in seconds (default: 10)"),
      },
    },
    async (params) => {
      try {
        const session = webSessionManager.getSession(params.sessionId);
        if (!session) {
          throw new Error(`Session '${params.sessionId}' not found`);
        }

        if (!params.selector && !params.text && !params.role) {
          throw new Error("Must provide selector, text, or role to identify element to click");
        }

        ctx.logger.info("Clicking element in web session", {
          sessionId: params.sessionId,
          selector: params.selector,
          text: params.text,
          role: params.role,
          operation: "web_session_click_start",
        });

        const timeout = (params.timeout || 10) * 1000;
        let locator;

        if (params.selector) {
          locator = session.page.locator(params.selector);
        } else if (params.text) {
          locator = session.page.getByText(params.text, { exact: false });
        } else if (params.role) {
          locator = session.page.getByRole(params.role as never);
        }

        // Wait for element to be visible and clickable
        await locator!.waitFor({ state: "visible", timeout });

        const beforeUrl = session.page.url();

        await locator!.click({
          button: params.button || "left",
          clickCount: params.clickCount || 1,
          timeout,
        });

        // Wait a moment for any navigation or changes
        await session.page.waitForTimeout(1000);

        const afterUrl = session.page.url();
        const navigationOccurred = beforeUrl !== afterUrl;

        ctx.logger.info("Element clicked successfully", {
          sessionId: params.sessionId,
          beforeUrl,
          afterUrl,
          navigationOccurred,
          operation: "web_session_click_success",
        });

        const result = navigationOccurred
          ? `Clicked element and navigated to: ${afterUrl}`
          : `Clicked element on page: ${afterUrl}`;

        return createSuccessResponse({
          output: result,
          title: "Element Clicked",
          metadata: {
            sessionId: params.sessionId,
            beforeUrl,
            afterUrl,
            navigationOccurred,
          },
        });
      } catch (error) {
        ctx.logger.error("Click action failed", {
          sessionId: params.sessionId,
          error: error instanceof Error ? error.message : String(error),
          operation: "web_session_click_error",
        });
        throw error;
      }
    },
  );

  // Close session
  server.registerTool(
    "web_session_close",
    {
      description: `Closes a web browser session and releases resources
      
- Closes the browser and frees up system resources
- Session cannot be used after closing
- Automatically happens after 30 minutes of inactivity
- Good practice to close sessions when done to save resources`,
      inputSchema: {
        sessionId: z.string().describe("Session identifier to close"),
      },
    },
    async (params) => {
      try {
        ctx.logger.info("Closing web session", {
          sessionId: params.sessionId,
          operation: "web_session_close_start",
        });

        const closed = await webSessionManager.closeSession(params.sessionId);

        if (!closed) {
          return createSuccessResponse({
            output: `Session '${params.sessionId}' was not found (may already be closed)`,
            title: "Session Not Found",
            metadata: { sessionId: params.sessionId },
          });
        }

        ctx.logger.info("Web session closed successfully", {
          sessionId: params.sessionId,
          operation: "web_session_close_success",
        });

        return createSuccessResponse({
          output: `Session '${params.sessionId}' closed successfully`,
          title: "Session Closed",
          metadata: { sessionId: params.sessionId },
        });
      } catch (error) {
        ctx.logger.error("Failed to close web session", {
          sessionId: params.sessionId,
          error: error instanceof Error ? error.message : String(error),
          operation: "web_session_close_error",
        });
        throw error;
      }
    },
  );

  // List active sessions
  server.registerTool(
    "web_session_list",
    {
      description: `Lists all active web browser sessions
      
- Shows session IDs, creation time, and last activity
- Helps track resource usage and manage multiple sessions
- Sessions auto-expire after 30 minutes of inactivity`,
      inputSchema: {},
    },
    () => {
      try {
        const sessions = webSessionManager.listSessions();

        const output = sessions.length === 0
          ? "No active web sessions"
          : sessions.map((session) =>
            `Session: ${session.id}\n` +
            `  Created: ${session.createdAt.toISOString()}\n` +
            `  Last Used: ${session.lastUsed.toISOString()}`
          ).join("\n\n");

        return createSuccessResponse({
          output,
          title: `Active Sessions (${sessions.length})`,
          metadata: { sessionCount: sessions.length, sessions },
        });
      } catch (error) {
        ctx.logger.error("Failed to list web sessions", {
          error: error instanceof Error ? error.message : String(error),
          operation: "web_session_list_error",
        });
        throw error;
      }
    },
  );
}

function convertHTMLToMarkdown(html: string): string {
  // Simplified HTML to markdown conversion
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
