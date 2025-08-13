import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";
import { webSessionManager } from "./session-manager.ts";

// Common cookie consent patterns and selectors
const CONSENT_PATTERNS = {
  // Accept button patterns
  acceptSelectors: [
    '[data-testid*="accept"]',
    '[data-cy*="accept"]',
    '[id*="accept"]',
    '[class*="accept"]',
    'button[title*="Accept"]',
    'button[aria-label*="Accept"]',
    'a[title*="Accept"]',
    // CookieBot
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#CybotCookiebotDialogBodyButtonAccept",
    // OneTrust
    "#onetrust-accept-btn-handler",
    ".onetrust-close-btn-handler",
    ".optanon-allow-all",
    // Quantcast
    ".qc-cmp2-summary-buttons > button:first-child",
    // TrustArc
    "#truste-consent-button",
    // Generic
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    'button:has-text("Allow all")',
    'button:has-text("Allow All")',
    'button:has-text("I agree")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
    'button:has-text("Got it")',
    'button:has-text("Continue")',
    'a:has-text("Accept")',
    'a:has-text("Continue")',
  ],

  // Reject/decline button patterns
  rejectSelectors: [
    '[data-testid*="reject"]',
    '[data-testid*="decline"]',
    '[id*="reject"]',
    '[class*="reject"]',
    'button[title*="Reject"]',
    'button[aria-label*="Reject"]',
    // OneTrust
    "#onetrust-reject-all-handler",
    ".optanon-reject-all",
    // Generic
    'button:has-text("Reject all")',
    'button:has-text("Reject All")',
    'button:has-text("Reject")',
    'button:has-text("Decline")',
    'button:has-text("No thanks")',
    'button:has-text("Necessary only")',
  ],

  // Consent banner/modal selectors
  bannerSelectors: [
    // OneTrust
    "#onetrust-banner-sdk",
    "#onetrust-consent-sdk",
    // CookieBot
    "#CybotCookiebotDialog",
    // Quantcast
    "#qcCmpUi",
    // TrustArc
    "#truste-consent-track",
    // Generic
    '[role="dialog"][aria-label*="cookie"]',
    '[role="dialog"][aria-label*="consent"]',
    '[class*="cookie"]',
    '[class*="consent"]',
    '[id*="cookie"]',
    '[id*="consent"]',
    ".gdpr-banner",
    ".privacy-banner",
    ".cookie-banner",
    ".consent-banner",
  ],
};

export function registerConsentTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "web_session_handle_consent",
    {
      description: `Automatically detects and handles cookie consent banners

- Detects common cookie consent patterns (OneTrust, CookieBot, Quantcast, etc.)
- Can accept or reject cookies based on preference
- Supports custom selectors for unusual consent implementations
- Returns details about what consent action was taken
- Works with the current page in an active web session`,
      inputSchema: {
        sessionId: z.string().describe("Session identifier"),
        action: z.enum(["accept", "reject", "detect"]).describe(
          "Action to take (accept/reject cookies or just detect)",
        ),
        customSelector: z.string().optional().describe("Custom CSS selector for consent button"),
        timeout: z.number().optional().describe("Timeout in seconds (default: 10)"),
        waitAfterClick: z.number().optional().describe(
          "Seconds to wait after clicking (default: 2)",
        ),
      },
    },
    async (params) => {
      try {
        const session = webSessionManager.getSession(params.sessionId);
        if (!session) {
          throw new Error(`Session '${params.sessionId}' not found`);
        }

        ctx.logger.info("Handling cookie consent", {
          sessionId: params.sessionId,
          action: params.action,
          customSelector: params.customSelector,
          operation: "web_session_consent_start",
        });

        const timeout = (params.timeout || 10) * 1000;
        const waitAfterClick = (params.waitAfterClick || 2) * 1000;

        // First, detect if there's a consent banner
        const detectedBanners = await detectConsentBanners(session.page, timeout);

        if (detectedBanners.length === 0) {
          return createSuccessResponse({
            output: "No cookie consent banners detected on the current page",
            title: "No Consent Banner Found",
            metadata: {
              sessionId: params.sessionId,
              action: params.action,
              bannersFound: 0,
            },
          });
        }

        ctx.logger.info("Consent banners detected", {
          sessionId: params.sessionId,
          bannersFound: detectedBanners.length,
          banners: detectedBanners,
          operation: "web_session_consent_detected",
        });

        if (params.action === "detect") {
          return createSuccessResponse({
            output: `Found ${detectedBanners.length} cookie consent banner(s):\n${
              detectedBanners.join("\n")
            }`,
            title: "Consent Banners Detected",
            metadata: {
              sessionId: params.sessionId,
              action: params.action,
              bannersFound: detectedBanners.length,
              banners: detectedBanners,
            },
          });
        }

        // Try to click the appropriate button
        let clickedSelector: string | null = null;
        let clickResult: string = "";

        if (params.customSelector) {
          // Use custom selector
          try {
            await session.page.locator(params.customSelector).click({ timeout });
            clickedSelector = params.customSelector;
            clickResult = `Clicked custom selector: ${params.customSelector}`;
          } catch (error) {
            throw new Error(`Failed to click custom selector '${params.customSelector}': ${error}`);
          }
        } else {
          // Use predefined patterns
          const selectors = params.action === "accept"
            ? CONSENT_PATTERNS.acceptSelectors
            : CONSENT_PATTERNS.rejectSelectors;

          for (const selector of selectors) {
            try {
              const element = session.page.locator(selector);
              const count = await element.count();

              if (count > 0) {
                // Check if element is visible
                const isVisible = await element.first().isVisible();
                if (isVisible) {
                  await element.first().click({ timeout: 5000 });
                  clickedSelector = selector;
                  clickResult = `Clicked ${params.action} button: ${selector}`;
                  break;
                }
              }
            } catch {
              // Continue to next selector
              continue;
            }
          }
        }

        if (!clickedSelector) {
          return createSuccessResponse({
            output: `Found consent banner(s) but could not find ${params.action} button to click`,
            title: "Consent Button Not Found",
            metadata: {
              sessionId: params.sessionId,
              action: params.action,
              bannersFound: detectedBanners.length,
              banners: detectedBanners,
            },
          });
        }

        // Wait for any changes after clicking
        await session.page.waitForTimeout(waitAfterClick);

        // Check if banner is gone
        const remainingBanners = await detectConsentBanners(session.page, 2000);
        const bannerDismissed = remainingBanners.length < detectedBanners.length;

        ctx.logger.info("Cookie consent handled", {
          sessionId: params.sessionId,
          action: params.action,
          clickedSelector,
          bannerDismissed,
          remainingBanners: remainingBanners.length,
          operation: "web_session_consent_success",
        });

        const successMessage = bannerDismissed
          ? `${clickResult} - Banner dismissed successfully`
          : `${clickResult} - Banner may still be visible`;

        return createSuccessResponse({
          output: successMessage,
          title: "Consent Handled",
          metadata: {
            sessionId: params.sessionId,
            action: params.action,
            clickedSelector,
            bannerDismissed,
            initialBanners: detectedBanners.length,
            remainingBanners: remainingBanners.length,
          },
        });
      } catch (error) {
        ctx.logger.error("Cookie consent handling failed", {
          sessionId: params.sessionId,
          action: params.action,
          error: error instanceof Error ? error.message : String(error),
          operation: "web_session_consent_error",
        });
        throw error;
      }
    },
  );

  server.registerTool(
    "web_session_wait_for_element",
    {
      description: `Waits for an element to appear, disappear, or become visible/hidden

- Useful for waiting for dynamic content to load
- Can wait for elements to appear or disappear
- Supports waiting for visibility changes
- Essential for handling dynamic cookie consent banners`,
      inputSchema: {
        sessionId: z.string().describe("Session identifier"),
        selector: z.string().describe("CSS selector for the element to wait for"),
        state: z.enum(["visible", "hidden", "attached", "detached"]).describe(
          "Element state to wait for",
        ),
        timeout: z.number().optional().describe("Timeout in seconds (default: 30)"),
      },
    },
    async (params) => {
      try {
        const session = webSessionManager.getSession(params.sessionId);
        if (!session) {
          throw new Error(`Session '${params.sessionId}' not found`);
        }

        ctx.logger.info("Waiting for element", {
          sessionId: params.sessionId,
          selector: params.selector,
          state: params.state,
          operation: "web_session_wait_start",
        });

        const timeout = (params.timeout || 30) * 1000;

        await session.page.locator(params.selector).waitFor({
          state: params.state,
          timeout,
        });

        ctx.logger.info("Element wait completed", {
          sessionId: params.sessionId,
          selector: params.selector,
          state: params.state,
          operation: "web_session_wait_success",
        });

        return createSuccessResponse({
          output: `Element '${params.selector}' is now ${params.state}`,
          title: "Element Wait Complete",
          metadata: {
            sessionId: params.sessionId,
            selector: params.selector,
            state: params.state,
          },
        });
      } catch (error) {
        ctx.logger.error("Element wait failed", {
          sessionId: params.sessionId,
          selector: params.selector,
          state: params.state,
          error: error instanceof Error ? error.message : String(error),
          operation: "web_session_wait_error",
        });
        throw error;
      }
    },
  );
}

// Helper function to detect consent banners
async function detectConsentBanners(page: unknown, _timeout: number): Promise<string[]> {
  const foundBanners: string[] = [];

  for (const selector of CONSENT_PATTERNS.bannerSelectors) {
    try {
      const element = page.locator(selector);
      const count = await element.count();

      if (count > 0) {
        const isVisible = await element.first().isVisible({ timeout: 1000 });
        if (isVisible) {
          foundBanners.push(selector);
        }
      }
    } catch {
      // Ignore errors for individual selectors
      continue;
    }
  }

  return foundBanners;
}
