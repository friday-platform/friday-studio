import { describe, expect, it } from "vitest";
import {
  assertChatMessage,
  assertChipVisible,
  assertElicitationVisible,
  assertSessionStatus,
  type BrowserController,
  clickButton,
  navigateToChat,
  sendMessage,
} from "./browser.ts";

interface FakeBrowserCall {
  kind: "goto" | "evaluate" | "waitFor" | "close";
  arg: string;
}

interface FakeBrowserOptions {
  /**
   * Predicate → boolean. Each `waitFor` and each `evaluate` of a boolean
   * expression is looked up by passing the raw expression. Default: true.
   */
  predicate?: (expression: string) => boolean;
}

/**
 * Generic-to-unknown bridge for the fake `evaluate`. The real CDP path has
 * the same shape (page-side value comes back as JSON-decoded unknown that
 * the caller is responsible for shape-checking) — see `coerceEvaluateValue`
 * in browser.ts. Single, isolated cast site.
 */
function coerceEvaluateValue<T>(value: unknown): T {
  return value as T;
}

function makeFakeBrowser(options: FakeBrowserOptions = {}): {
  calls: FakeBrowserCall[];
  browser: BrowserController;
} {
  const calls: FakeBrowserCall[] = [];
  const predicate = options.predicate ?? (() => true);
  const browser: BrowserController = {
    goto(url: string): Promise<void> {
      calls.push({ kind: "goto", arg: url });
      return Promise.resolve();
    },
    evaluate<T>(expression: string): Promise<T> {
      calls.push({ kind: "evaluate", arg: expression });
      return Promise.resolve(coerceEvaluateValue<T>(predicate(expression)));
    },
    waitFor(pred: string): Promise<void> {
      calls.push({ kind: "waitFor", arg: pred });
      if (!predicate(pred)) {
        return Promise.reject(new Error(`waitFor predicate refused: ${pred}`));
      }
      return Promise.resolve();
    },
    close(): Promise<void> {
      calls.push({ kind: "close", arg: "" });
      return Promise.resolve();
    },
  };
  return { calls, browser };
}

describe("navigateToChat", () => {
  it("defaults to the playground base", async () => {
    const { calls, browser } = makeFakeBrowser();
    await navigateToChat(browser, "oauth-refresh-qa");
    expect(calls[0]).toEqual({
      kind: "goto",
      arg: "http://localhost:5200/platform/oauth-refresh-qa/chat",
    });
  });

  it("encodes workspace ids with special characters", async () => {
    const { calls, browser } = makeFakeBrowser();
    await navigateToChat(browser, "ws/with space", { studioBaseUrl: "http://example.test" });
    expect(calls[0]?.arg).toEqual("http://example.test/platform/ws%2Fwith%20space/chat");
  });
});

describe("sendMessage", () => {
  it("waits for the input then evaluates an embedded script with the literal text", async () => {
    const { calls, browser } = makeFakeBrowser();
    await sendMessage(browser, "what's on my calendar?");
    expect(calls[0]?.kind).toEqual("waitFor");
    expect(calls[1]?.kind).toEqual("evaluate");
    expect(calls[1]?.arg).toContain(`"what's on my calendar?"`);
  });

  it("escapes embedded quotes safely", async () => {
    const { calls, browser } = makeFakeBrowser();
    await sendMessage(browser, 'with "quote"');
    // JSON.stringify wraps in double quotes and escapes the inner ones.
    expect(calls[1]?.arg).toContain('"with \\"quote\\""');
  });
});

describe("clickButton", () => {
  it("emits an evaluate that looks up the literal label", async () => {
    const { calls, browser } = makeFakeBrowser();
    await clickButton(browser, "Retry");
    expect(calls[0]?.kind).toEqual("evaluate");
    expect(calls[0]?.arg).toContain('"Retry"');
  });
});

describe("assertChipVisible", () => {
  it("waits for a predicate that contains the supplied regex", async () => {
    const { calls, browser } = makeFakeBrowser();
    await assertChipVisible(browser, /reconnect.*google/i);
    expect(calls[0]?.kind).toEqual("waitFor");
    expect(calls[0]?.arg).toContain(`"reconnect.*google"`);
    expect(calls[0]?.arg).toContain(`"i"`);
  });

  it("propagates the underlying waitFor failure", async () => {
    const { browser } = makeFakeBrowser({ predicate: () => false });
    await expect(assertChipVisible(browser, /never/)).rejects.toThrow(/waitFor predicate refused/);
  });
});

describe("assertElicitationVisible", () => {
  it("waits for a predicate that mentions both labels", async () => {
    const { calls, browser } = makeFakeBrowser();
    await assertElicitationVisible(browser, /retry/i, /cancel/i);
    expect(calls[0]?.kind).toEqual("waitFor");
    expect(calls[0]?.arg).toContain(`"retry"`);
    expect(calls[0]?.arg).toContain(`"cancel"`);
  });
});

describe("assertChatMessage", () => {
  it("waits on a regex over chat-message bubbles", async () => {
    const { calls, browser } = makeFakeBrowser();
    await assertChatMessage(browser, /events|calendar/i);
    expect(calls[0]?.arg).toContain(`"events|calendar"`);
    expect(calls[0]?.arg).toContain(`data-testid="chat-message"`);
  });
});

describe("assertSessionStatus", () => {
  it("queries the global session-status badge by default", async () => {
    const { calls, browser } = makeFakeBrowser();
    await assertSessionStatus(browser, "FAILED");
    expect(calls[0]?.arg).toContain(`"FAILED"`);
    expect(calls[0]?.arg).toContain(`[data-testid=\\"session-status\\"]`);
  });

  it("scopes to a session id when given", async () => {
    const { calls, browser } = makeFakeBrowser();
    await assertSessionStatus(browser, "SKIPPED", { sessionId: "sess_123" });
    expect(calls[0]?.arg).toContain("sess_123");
  });
});
