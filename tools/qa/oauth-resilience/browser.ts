/**
 * Browser harness for OAuth resilience QA scenarios.
 *
 * Provides high-level helpers (navigateToChat, sendMessage, clickButton,
 * assertChipVisible, ...) on top of a `BrowserController` abstraction so
 * scenarios stay declarative.
 *
 * Two controller implementations are exported:
 *
 *   - `connectCdpController` — talks to a real Chrome via the DevTools
 *     Protocol over a WebSocket. Used by `openChrome()` which also spawns
 *     Chrome with `--remote-debugging-port`.
 *   - The interface itself — so unit tests (and the eventual claude-in-chrome
 *     MCP shim) can plug their own implementation in without touching the
 *     scenario code.
 *
 * Why CDP and not a Node library: this runner is a Deno script. CDP is just
 * a WebSocket protocol — no external dependency beyond a Chrome on PATH.
 *
 * Scope note: this is the SKELETON. Scenarios (tasks #22–#25) will exercise
 * the helpers and probably push extra ones in. We deliberately keep the
 * surface minimal here.
 */

const DEFAULT_CHROME_CANDIDATES: ReadonlyArray<string> = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "google-chrome",
  "chromium",
  "chrome",
];

/**
 * Abstraction over a single browser tab/page. Scenarios consume this
 * exclusively — they never touch CDP directly. New helpers should be added
 * here when more than one scenario needs them.
 */
export interface BrowserController {
  /** Navigate the active page to `url`. Waits for the load event. */
  goto(url: string): Promise<void>;
  /**
   * Evaluate `expression` in the page context and return the value. The
   * expression should serialize to a JSON-safe value — for richer return
   * shapes use a typed helper.
   */
  evaluate<T>(expression: string): Promise<T>;
  /**
   * Wait until `predicate` (a JS expression evaluated in the page) returns a
   * truthy value, polling every `intervalMs` (default 100). Times out after
   * `timeoutMs` (default 10_000).
   */
  waitFor(predicate: string, options?: { timeoutMs?: number; intervalMs?: number }): Promise<void>;
  /** Close the page and underlying connection. Idempotent. */
  close(): Promise<void>;
}

export interface OpenChromeOptions {
  /** Chrome binary path. Resolved from a small candidate list when omitted. */
  chromeBinary?: string;
  /** Remote-debugging port. 0 = pick ephemeral. */
  port?: number;
  /** Run headless. Defaults to true for CI; flip false for live debugging. */
  headless?: boolean;
  /** User-data dir. Defaults to a tmp dir created per-call. */
  userDataDir?: string;
  /** Extra args appended after Chrome's required ones. */
  extraArgs?: string[];
}

export interface ChromeHandle extends BrowserController {
  /** Spawned Chrome process — exposed so callers can SIGTERM if needed. */
  process: Deno.ChildProcess;
  /** Final remote-debugging URL (e.g. `http://127.0.0.1:9222`). */
  debugUrl: string;
}

/**
 * Spawn Chrome with remote debugging enabled and connect a controller to
 * its first tab. Returns a handle that also implements `BrowserController`
 * for ergonomic use.
 */
export async function openChrome(options: OpenChromeOptions = {}): Promise<ChromeHandle> {
  const chromeBinary = options.chromeBinary ?? (await findChromeBinary());
  const port = options.port ?? 0;
  const headless = options.headless ?? true;
  const userDataDir =
    options.userDataDir ?? (await Deno.makeTempDir({ prefix: "friday-qa-chrome-" }));

  const args: string[] = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--disable-background-networking",
    "--disable-sync",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");
  if (options.extraArgs) args.push(...options.extraArgs);

  const proc = new Deno.Command(chromeBinary, {
    args,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).spawn();

  // Chrome writes the actual remote-debugging URL to stderr on startup:
  //   "DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<id>"
  // We tail stderr until we see that line, then HTTP-discover the first page.
  const debugPort = await readChromeDebugPort(proc.stderr, 30_000);
  const debugUrl = `http://127.0.0.1:${debugPort}`;
  const controller = await connectCdpController(debugUrl);

  return {
    debugUrl,
    process: proc,
    goto: (url) => controller.goto(url),
    evaluate: (expr) => controller.evaluate(expr),
    waitFor: (pred, opts) => controller.waitFor(pred, opts),
    close: async () => {
      try {
        await controller.close();
      } finally {
        try {
          proc.kill("SIGTERM");
        } catch {
          // already dead
        }
        await proc.status;
      }
    },
  };
}

async function findChromeBinary(): Promise<string> {
  for (const candidate of DEFAULT_CHROME_CANDIDATES) {
    if (candidate.includes("/")) {
      try {
        await Deno.stat(candidate);
        return candidate;
      } catch {
        // try next
      }
    } else {
      // Bare command name — trust PATH; the spawn itself will surface
      // a clearer error if it's not actually there.
      return candidate;
    }
  }
  throw new Error("no Chrome/Chromium binary found");
}

async function readChromeDebugPort(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<number> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const match = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        const port = Number(match[1]);
        if (Number.isFinite(port)) return port;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  throw new Error("Chrome did not advertise its remote-debugging port within timeout");
}

interface DevToolsTarget {
  type: string;
  webSocketDebuggerUrl: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDevToolsTargets(value: unknown): DevToolsTarget[] {
  if (!Array.isArray(value)) throw new Error("/json from Chrome was not an array");
  const out: DevToolsTarget[] = [];
  for (const raw of value) {
    if (!isPlainRecord(raw)) continue;
    const t = raw.type;
    const ws = raw.webSocketDebuggerUrl;
    if (typeof t === "string" && typeof ws === "string") {
      out.push({ type: t, webSocketDebuggerUrl: ws });
    }
  }
  return out;
}

/**
 * Connect a controller to an already-running Chrome at `debugUrl`. Picks the
 * first page target. Exported so tests / agents can drive a Chrome that was
 * launched out-of-band.
 */
export async function connectCdpController(debugUrl: string): Promise<BrowserController> {
  const res = await fetch(`${debugUrl}/json`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${debugUrl}/json failed: ${res.status} ${text}`);
  }
  const targets = parseDevToolsTargets(await res.json());
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error(`no page target found at ${debugUrl}`);
  return await openCdpPage(page.webSocketDebuggerUrl);
}

interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
}

/**
 * Open a CDP session against `wsUrl` and return a BrowserController. The
 * session is single-tab and single-frame; if a scenario needs multiple tabs
 * it can call `connectCdpController` again against the same debugUrl.
 */
export async function openCdpPage(wsUrl: string): Promise<BrowserController> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket open failed")), {
      once: true,
    });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const eventWaiters: Array<(ev: CdpEvent) => boolean> = [];

  function parseError(value: unknown): { code: number; message: string } | null {
    if (!isPlainRecord(value)) return null;
    const code = value.code;
    const message = value.message;
    if (typeof code !== "number" || typeof message !== "string") return null;
    return { code, message };
  }

  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isPlainRecord(parsed)) return;
    const id = parsed.id;
    const method = parsed.method;
    const result = parsed.result;
    const error = parseError(parsed.error);
    if (typeof id === "number") {
      const slot = pending.get(id);
      if (!slot) return;
      pending.delete(id);
      if (error) slot.reject(new Error(`CDP error ${error.code}: ${error.message}`));
      else slot.resolve(result);
      return;
    }
    if (typeof method === "string") {
      const params = parsed.params;
      const ev: CdpEvent = { method, params: isPlainRecord(params) ? params : {} };
      for (let i = eventWaiters.length - 1; i >= 0; i -= 1) {
        const waiter = eventWaiters[i];
        if (waiter?.(ev)) {
          eventWaiters.splice(i, 1);
        }
      }
    }
  });

  /**
   * Send a CDP command and resolve with the `result` field. Callers narrow
   * the unknown payload with a typed parser at the call site — there's no
   * honest way to enforce typing across the JSON boundary, so don't pretend
   * the result is already shaped.
   */
  function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = nextId;
    nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function waitForEvent(method: string, timeoutMs: number): Promise<CdpEvent> {
    return new Promise<CdpEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`CDP event ${method} did not fire within ${timeoutMs}ms`));
      }, timeoutMs);
      eventWaiters.push((ev) => {
        if (ev.method !== method) return false;
        clearTimeout(timer);
        resolve(ev);
        return true;
      });
    });
  }

  await send("Page.enable");
  await send("Runtime.enable");

  /**
   * Narrow a `Runtime.evaluate` payload. The full CDP shape is:
   *   { result?: { value?, type?, ... }, exceptionDetails?: { text?, ... } }
   * We pluck out the two fields the controller surfaces and ignore the rest.
   */
  function parseEvaluateResult(raw: unknown): { value: unknown; exceptionText: string | null } {
    if (!isPlainRecord(raw)) return { value: undefined, exceptionText: null };
    const inner = raw.result;
    const value = isPlainRecord(inner) ? inner.value : undefined;
    const ex = raw.exceptionDetails;
    let exceptionText: string | null = null;
    if (isPlainRecord(ex)) {
      const t = ex.text;
      exceptionText = typeof t === "string" ? t : "unknown";
    }
    return { value, exceptionText };
  }

  /**
   * Caller-supplied evaluators force their own narrowing on the unknown
   * `value` returned from the page. This single-cast bridge is unavoidable
   * at the JSON-to-T boundary; gate it behind a named helper so the rest of
   * the module never sprinkles `as T` casts.
   */
  function coerceEvaluateValue<T>(value: unknown): T {
    return value as T;
  }

  const controller: BrowserController = {
    async goto(url: string): Promise<void> {
      const loaded = waitForEvent("Page.loadEventFired", 30_000);
      await send("Page.navigate", { url });
      await loaded;
    },
    async evaluate<T>(expression: string): Promise<T> {
      const raw = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      const { value, exceptionText } = parseEvaluateResult(raw);
      if (exceptionText !== null) {
        throw new Error(`page exception: ${exceptionText}`);
      }
      return coerceEvaluateValue<T>(value);
    },
    async waitFor(
      predicate: string,
      options?: { timeoutMs?: number; intervalMs?: number },
    ): Promise<void> {
      const timeoutMs = options?.timeoutMs ?? 10_000;
      const intervalMs = options?.intervalMs ?? 100;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const truthy = await controller.evaluate<boolean>(`Boolean(${predicate})`);
        if (truthy) return;
        await new Promise<void>((r) => setTimeout(r, intervalMs));
      }
      throw new Error(`waitFor(${predicate}) timed out after ${timeoutMs}ms`);
    },
    close(): Promise<void> {
      try {
        ws.close();
      } catch {
        // already closed
      }
      for (const slot of pending.values()) {
        slot.reject(new Error("CDP connection closed"));
      }
      pending.clear();
      return Promise.resolve();
    },
  };

  return controller;
}

// ──────────────────────────────────────────────────────────────────────────
// High-level scenario helpers
// ──────────────────────────────────────────────────────────────────────────

export interface NavigateToChatOptions {
  /** Friday Studio base URL. Defaults to `http://localhost:5200`. */
  studioBaseUrl?: string;
}

/**
 * Navigate the controller to a workspace's direct chat page. The URL pattern
 * mirrors the playground / Studio route convention; scenarios can override
 * the base for tests against an external daemon URL.
 */
export async function navigateToChat(
  browser: BrowserController,
  workspaceId: string,
  options: NavigateToChatOptions = {},
): Promise<void> {
  const base = options.studioBaseUrl ?? "http://localhost:5200";
  await browser.goto(`${base}/platform/${encodeURIComponent(workspaceId)}/chat`);
}

/**
 * Send a message in the currently-open chat. The chat input is identified
 * by `data-testid="chat-input"` (added in the Studio chat component);
 * scenarios fall back to the first contenteditable if needed.
 */
export async function sendMessage(browser: BrowserController, text: string): Promise<void> {
  await browser.waitFor(
    `document.querySelector('[data-testid="chat-input"], [data-testid="chat-composer"], textarea')`,
  );
  const escaped = JSON.stringify(text);
  await browser.evaluate<void>(`
    (() => {
      const el = document.querySelector('[data-testid="chat-input"], [data-testid="chat-composer"], textarea');
      if (!el) throw new Error("chat input not found");
      const input = el;
      if ("value" in input) {
        input.value = ${escaped};
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        input.textContent = ${escaped};
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
      const form = input.closest("form");
      if (form) {
        form.requestSubmit ? form.requestSubmit() : form.submit();
      } else {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
    })();
  `);
}

/**
 * Click the first visible button whose accessible text matches `label`
 * (exact match, case-sensitive). Used for "Retry" / "Cancel" elicitation
 * buttons.
 */
export async function clickButton(browser: BrowserController, label: string): Promise<void> {
  const escaped = JSON.stringify(label);
  await browser.evaluate<void>(`
    (() => {
      const buttons = Array.from(document.querySelectorAll("button, [role=button]"));
      const target = buttons.find((b) => {
        const text = (b.textContent ?? "").trim();
        return text === ${escaped};
      });
      if (!target) throw new Error("button not found: " + ${escaped});
      target.click();
    })();
  `);
}

function regexLiteral(pattern: RegExp): string {
  return `new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)})`;
}

/**
 * Wait until an integration-disconnect chip becomes visible AND its text
 * matches `pattern`. Matches both the legacy attribute hook
 * (`data-integration-disconnected`) and the test-id forms — the Phase 3
 * chip uses `data-testid="integration-chip-${kind}"` (kind-suffixed) so
 * the selector uses a prefix match. Times out at 15s by default.
 */
export async function assertChipVisible(
  browser: BrowserController,
  pattern: RegExp,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await browser.waitFor(
    `(() => {
      const re = ${regexLiteral(pattern)};
      const els = document.querySelectorAll('[data-testid^="integration-chip"], [data-integration-disconnected]');
      for (const el of els) {
        if (re.test((el.textContent ?? "").trim())) return true;
      }
      return false;
    })()`,
    { timeoutMs: options.timeoutMs ?? 15_000 },
  );
}

/**
 * Wait until the auth-refresh elicitation chip is visible. The chip is
 * located by `data-testid="auth-refresh-elicitation"` (assumed; verify when
 * Phase 3 UI lands in task #16). Validates that both `retryLabel` and
 * `cancelLabel` patterns appear as button text inside it.
 */
export async function assertElicitationVisible(
  browser: BrowserController,
  retryLabel: RegExp,
  cancelLabel: RegExp,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await browser.waitFor(
    `(() => {
      const chip = document.querySelector('[data-testid="auth-refresh-elicitation"]');
      if (!chip) return false;
      const buttons = Array.from(chip.querySelectorAll("button, [role=button]"));
      const retryRe = ${regexLiteral(retryLabel)};
      const cancelRe = ${regexLiteral(cancelLabel)};
      const hasRetry = buttons.some((b) => retryRe.test((b.textContent ?? "").trim()));
      const hasCancel = buttons.some((b) => cancelRe.test((b.textContent ?? "").trim()));
      return hasRetry && hasCancel;
    })()`,
    { timeoutMs: options.timeoutMs ?? 30_000 },
  );
}

/**
 * Wait until at least one chat message bubble's text matches `pattern`.
 */
export async function assertChatMessage(
  browser: BrowserController,
  pattern: RegExp,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await browser.waitFor(
    `(() => {
      const re = ${regexLiteral(pattern)};
      const messages = document.querySelectorAll('[data-testid="chat-message"], [role=listitem]');
      for (const m of messages) {
        if (re.test((m.textContent ?? "").trim())) return true;
      }
      return false;
    })()`,
    { timeoutMs: options.timeoutMs ?? 60_000 },
  );
}

/**
 * Assert that a specific session row reaches `status`. The runner is
 * expected to navigate to the Sessions page first; this helper only waits
 * for the status badge.
 */
export async function assertSessionStatus(
  browser: BrowserController,
  status: "COMPLETED" | "FAILED" | "SKIPPED" | "CANCELLED",
  options: { sessionId?: string; timeoutMs?: number } = {},
): Promise<void> {
  const selector = options.sessionId
    ? `[data-session-id="${options.sessionId}"] [data-testid="session-status"]`
    : `[data-testid="session-status"]`;
  const escapedSelector = JSON.stringify(selector);
  const escapedStatus = JSON.stringify(status);
  await browser.waitFor(
    `(() => {
      const el = document.querySelector(${escapedSelector});
      if (!el) return false;
      return (el.textContent ?? "").trim().toUpperCase() === ${escapedStatus};
    })()`,
    { timeoutMs: options.timeoutMs ?? 30_000 },
  );
}
