/**
 * Mock Cloud Function for OAuth refresh-resilience QA scenarios.
 *
 * Mirrors the routes and response shapes of the Gemini CLI Workspace Extension
 * Cloud Function (https://google-workspace-extension.geminicli.com) so Friday
 * Studio can drive its delegated-OAuth code paths against a controllable
 * fixture instead of the real third-party endpoint.
 *
 * The control plane (POST /control/*) lets a QA harness flip the
 * /refreshToken response shape per scenario without restarting the server.
 */

export type MockOAuthMode =
  | "success"
  | "invalid_grant"
  | "invalid_client"
  | "http_500_text"
  | "http_500_json"
  | "http_429"
  | "malformed_body"
  | "hang"
  | "netfail"
  | "flaky";

const ALL_MODES: ReadonlySet<MockOAuthMode> = new Set<MockOAuthMode>([
  "success",
  "invalid_grant",
  "invalid_client",
  "http_500_text",
  "http_500_json",
  "http_429",
  "malformed_body",
  "hang",
  "netfail",
  "flaky",
]);

function isMockOAuthMode(value: unknown): value is MockOAuthMode {
  if (typeof value !== "string") return false;
  // Set<MockOAuthMode>.has() accepts only MockOAuthMode in its type, but at
  // runtime it accepts any value — so funnel the unknown string through a
  // local widened reference to keep the call site cast-free.
  const widened: ReadonlySet<string> = ALL_MODES;
  return widened.has(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface MockOAuthServerHandle {
  url: string;
  stop: () => Promise<void>;
}

interface ControlState {
  mode: MockOAuthMode;
  payload: unknown;
  flakyCallCount: number;
  counts: Map<MockOAuthMode, number>;
  pending: Set<AbortController>;
}

function initialState(): ControlState {
  return {
    mode: "success",
    payload: undefined,
    flakyCallCount: 0,
    counts: new Map(),
    pending: new Set(),
  };
}

interface SyntheticTokens {
  access_token: string;
  expiry_date: number;
  token_type: string;
  scope: string;
}

function syntheticSuccessBody(): SyntheticTokens {
  return {
    access_token: `mock_access_${crypto.randomUUID()}`,
    expiry_date: Date.now() + 3_600_000,
    token_type: "Bearer",
    scope: "openid email https://www.googleapis.com/auth/calendar",
  };
}

function bumpCount(state: ControlState, mode: MockOAuthMode): void {
  state.counts.set(mode, (state.counts.get(mode) ?? 0) + 1);
}

/**
 * Stream-error response: opens a body stream and immediately errors it. The
 * client sees an incomplete response / network failure — the closest portable
 * approximation of a TCP mid-stream close inside the Deno.serve handler model.
 */
function netfailResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("mock netfail"));
    },
  });
  return new Response(stream, { status: 200 });
}

/**
 * Returns a promise that resolves only when the request is aborted (by the
 * client or by the server shutting down). No headers are sent until abort,
 * so on the client side fetch() itself never resolves — which is what
 * exercises AbortSignal.timeout in the refresh classifier.
 */
function hangResponse(state: ControlState, requestSignal: AbortSignal): Promise<Response> {
  const ac = new AbortController();
  state.pending.add(ac);
  return new Promise<Response>((resolve) => {
    const finish = (): void => {
      state.pending.delete(ac);
      resolve(new Response(null, { status: 503 }));
    };
    if (ac.signal.aborted || requestSignal.aborted) {
      finish();
      return;
    }
    ac.signal.addEventListener("abort", finish, { once: true });
    requestSignal.addEventListener("abort", finish, { once: true });
  });
}

function resolveFlakyRecoveryMode(payload: unknown): MockOAuthMode {
  if (!isMockOAuthMode(payload)) return "success";
  return payload === "flaky" ? "success" : payload;
}

function buildRefreshResponse(
  state: ControlState,
  requestSignal: AbortSignal,
): Response | Promise<Response> {
  let effectiveMode: MockOAuthMode = state.mode;
  if (state.mode === "flaky") {
    state.flakyCallCount += 1;
    bumpCount(state, "flaky");
    if (state.flakyCallCount === 1) {
      return new Response("An error occurred during token refresh.", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
    }
    // Subsequent calls follow what the harness explicitly asked flaky to
    // recover to. Default to "success" if no payload was provided.
    effectiveMode = resolveFlakyRecoveryMode(state.payload);
  } else {
    bumpCount(state, state.mode);
  }

  switch (effectiveMode) {
    case "success":
      return Response.json(syntheticSuccessBody());
    case "invalid_grant":
      return Response.json(
        { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        { status: 400 },
      );
    case "invalid_client":
      return Response.json({ error: "invalid_client" }, { status: 400 });
    case "http_500_text":
      return new Response("An error occurred during token refresh.", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
    case "http_500_json":
      return Response.json(
        {
          error: "internal_failure",
          error_description: "Upstream Google token endpoint returned 500.",
        },
        { status: 500 },
      );
    case "http_429":
      return Response.json(
        { error: "rate_limit_exceeded", error_description: "Too many refresh attempts." },
        { status: 429 },
      );
    case "malformed_body":
      return new Response("{not valid json", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    case "hang":
      return hangResponse(state, requestSignal);
    case "netfail":
      return netfailResponse();
    case "flaky":
      // Unreachable: flaky is handled above before the switch.
      return Response.json(syntheticSuccessBody());
    default: {
      const exhaustive: never = effectiveMode;
      throw new Error(`Unhandled mode: ${String(exhaustive)}`);
    }
  }
}

function buildCallbackRedirect(stateParam: string | null): Response {
  if (stateParam === null) {
    return new Response("Missing state parameter.", { status: 400 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(stateParam));
  } catch {
    return new Response("Malformed state payload.", { status: 400 });
  }
  if (!isPlainRecord(parsed)) {
    return new Response("Malformed state payload.", { status: 400 });
  }
  const uri = parsed["uri"];
  if (typeof uri !== "string") {
    return new Response("State payload missing uri.", { status: 400 });
  }
  let target: URL;
  try {
    target = new URL(uri);
  } catch {
    return new Response("Invalid uri in state payload.", { status: 400 });
  }
  if (target.hostname !== "localhost" && target.hostname !== "127.0.0.1") {
    return new Response(
      `Invalid redirect hostname: ${target.hostname}. Must be localhost or 127.0.0.1.`,
      { status: 400 },
    );
  }

  const tokens = syntheticSuccessBody();
  target.searchParams.append("access_token", tokens.access_token);
  target.searchParams.append("refresh_token", `mock_refresh_${crypto.randomUUID()}`);
  target.searchParams.append("scope", tokens.scope);
  target.searchParams.append("token_type", tokens.token_type);
  target.searchParams.append("expiry_date", tokens.expiry_date.toString());
  const csrf = parsed["csrf"];
  if (typeof csrf === "string") {
    target.searchParams.append("state", csrf);
  }
  return Response.redirect(target.toString(), 302);
}

async function handleControlMode(req: Request, state: ControlState): Promise<Response> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    return new Response("Invalid JSON body.", { status: 400 });
  }
  if (!isPlainRecord(raw)) {
    return new Response("Control body must be a JSON object.", { status: 400 });
  }
  const nextMode = raw["mode"];
  if (!isMockOAuthMode(nextMode)) {
    return new Response(`Invalid mode. Expected one of: ${[...ALL_MODES].join(", ")}`, {
      status: 400,
    });
  }
  state.mode = nextMode;
  state.payload = raw["payload"];
  // Reset flaky's per-mode counter so each switch into "flaky" gets a fresh
  // first-call-fails semantics.
  if (nextMode === "flaky") {
    state.flakyCallCount = 0;
  }
  return Response.json({ ok: true, mode: state.mode });
}

function handleControlCounts(state: ControlState): Response {
  const byMode: Record<string, number> = {};
  let total = 0;
  for (const [mode, count] of state.counts) {
    byMode[mode] = count;
    total += count;
  }
  return Response.json({ total, byMode, flakyCallCount: state.flakyCallCount });
}

function handleControlReset(state: ControlState): Response {
  state.mode = "success";
  state.payload = undefined;
  state.flakyCallCount = 0;
  state.counts.clear();
  return Response.json({ ok: true });
}

export async function startMockOAuthServer(port: number): Promise<MockOAuthServerHandle> {
  const state = initialState();
  const serverController = new AbortController();

  let listenPort = 0;
  const ready = new Promise<void>((resolve) => {
    const server = Deno.serve(
      {
        port,
        hostname: "127.0.0.1",
        signal: serverController.signal,
        onListen: ({ port: actual }) => {
          listenPort = actual;
          resolve();
        },
      },
      (req) => {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;

        if (path === "/refreshToken" && method === "POST") {
          return buildRefreshResponse(state, req.signal);
        }
        if (path === "/callback" && method === "POST") {
          return buildCallbackRedirect(url.searchParams.get("state"));
        }
        if (path === "/control/mode" && method === "POST") {
          return handleControlMode(req, state);
        }
        if (path === "/control/counts" && method === "POST") {
          return handleControlCounts(state);
        }
        if (path === "/control/reset" && method === "POST") {
          return handleControlReset(state);
        }
        return new Response("Not Found", { status: 404 });
      },
    );
    // Hold a reference so the server isn't GC'd before stop().
    void server;
  });

  await ready;

  return {
    url: `http://127.0.0.1:${listenPort}`,
    stop: async (): Promise<void> => {
      // Wake any pending hang responses so they release their streams before
      // the server tears down.
      for (const ac of state.pending) {
        ac.abort();
      }
      state.pending.clear();
      serverController.abort();
      // Give Deno.serve a tick to flush the abort.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}
