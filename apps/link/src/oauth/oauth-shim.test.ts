import { describe, expect, it } from "vitest";
import { rewriteToOAuthShim } from "./service.ts";

// rewriteToOAuthShim is the helper that solves the "Success! Credentials
// Ready" manual-paste page surfacing on desktop installs. The Gemini CLI
// Cloud Function's `state.uri` validator does a literal-string hostname
// check against `localhost` / `127.0.0.1` (see github.com/gemini-cli-
// extensions/workspace cloud_function/index.js#L91-L104), so the desktop
// install's `https://local.hellofriday.ai:15200/...` callback URL is
// rejected even though that hostname resolves to 127.0.0.1. The shim
// rewrites the host+port+scheme of the URL to point at the playground's
// loopback HTTP listener, which 302-redirects to the browser-trusted
// origin so Link's existing callback handler runs unchanged.

describe("rewriteToOAuthShim", () => {
  it("returns the original URL when shim base is empty", () => {
    // Dev rigs hit this branch — the playground already binds at
    // `localhost`, so the Cloud Function accepts the callback URL as-is.
    expect(rewriteToOAuthShim("https://local.hellofriday.ai:15200/cb/google-calendar", "")).toBe(
      "https://local.hellofriday.ai:15200/cb/google-calendar",
    );
  });

  it("returns the original URL when shim base is undefined", () => {
    expect(rewriteToOAuthShim("https://local.hellofriday.ai:15200/cb/x", undefined)).toBe(
      "https://local.hellofriday.ai:15200/cb/x",
    );
  });

  it("swaps host+port+scheme to the shim, preserving pathname and query", () => {
    // Canonical desktop-install case: the callback URL Link would
    // otherwise emit gets rerouted to the loopback shim. The shim's
    // 302 hop back to the TLS origin restores the path+query so the
    // real callback handler runs unchanged.
    const got = rewriteToOAuthShim(
      "https://local.hellofriday.ai:15200/api/daemon/api/link/v1/callback/google-calendar?already=here",
      "http://127.0.0.1:15201",
    );
    const parsed = new URL(got);
    expect(parsed.protocol).toBe("http:");
    expect(parsed.host).toBe("127.0.0.1:15201");
    expect(parsed.pathname).toBe("/api/daemon/api/link/v1/callback/google-calendar");
    expect(parsed.search).toBe("?already=here");
  });

  it("falls back to the original URL when the callback URL is malformed", () => {
    // Defensive: a programmer-error URL shouldn't produce a worse
    // failure mode than the pre-shim behavior — let the Cloud
    // Function reject it normally instead of emitting nonsense.
    const bad = "not a url";
    expect(rewriteToOAuthShim(bad, "http://127.0.0.1:15201")).toBe(bad);
  });

  it("falls back to the original URL when the shim base is malformed", () => {
    const cb = "https://local.hellofriday.ai:15200/cb/google-calendar";
    expect(rewriteToOAuthShim(cb, "not a url")).toBe(cb);
  });

  it("encodes the URL output the same way URL.toString does", () => {
    // The Gemini Cloud Function base64-decodes state, JSON-parses, and
    // hands `state.uri` to `new URL()`. Round-tripping through URL.toString
    // is what guarantees the string is parseable on the other side; this
    // test pins that we don't accidentally hand back a half-encoded form.
    const got = rewriteToOAuthShim(
      "https://local.hellofriday.ai:15200/api/daemon/api/link/v1/callback/google-calendar?state=abc%2Bdef",
      "http://127.0.0.1:15201",
    );
    expect(() => new URL(got)).not.toThrow();
    expect(new URL(got).searchParams.get("state")).toBe("abc+def");
  });
});
