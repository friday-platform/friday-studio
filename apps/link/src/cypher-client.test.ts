import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CypherAuthError,
  CypherDecryptError,
  CypherError,
  CypherHttpClient,
  CypherTimeoutError,
} from "./cypher-client.ts";

describe("CypherHttpClient", () => {
  const mockGetToken = () => Promise.resolve("test-token");

  it("constructor validates baseUrl", () => {
    // Valid URLs
    new CypherHttpClient("https://cypher.test", mockGetToken);
    new CypherHttpClient("http://localhost:8085", mockGetToken);

    // Invalid URLs
    try {
      new CypherHttpClient("", mockGetToken);
      throw new Error("Should have thrown");
    } catch (e) {
      expect((e as Error).message).toEqual("Invalid baseUrl: must be a valid HTTP(S) URL");
    }

    try {
      new CypherHttpClient("not-a-url", mockGetToken);
      throw new Error("Should have thrown");
    } catch (e) {
      expect((e as Error).message).toEqual("Invalid baseUrl: must be a valid HTTP(S) URL");
    }
  });

  it("encrypt: success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ ciphertext: ["encrypted1", "encrypted2"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    try {
      const client = new CypherHttpClient("https://cypher.test", mockGetToken);
      const result = await client.encrypt(["secret1", "secret2"]);
      expect(result).toEqual(["encrypted1", "encrypted2"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("encrypt: sends correct request", async () => {
    const originalFetch = globalThis.fetch;
    const captured: { url: string; method: string; headers: Headers; body: string }[] = [];

    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: input.toString(),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body as string,
      });
      return Promise.resolve(new Response(JSON.stringify({ ciphertext: ["ct"] }), { status: 200 }));
    };

    try {
      const client = new CypherHttpClient("https://cypher.test/", mockGetToken); // trailing slash
      await client.encrypt(["plaintext"]);

      const req = captured[0];
      expect(req?.url).toEqual("https://cypher.test/encrypt");
      expect(req?.method).toEqual("POST");
      expect(req?.headers.get("Authorization")).toEqual("Bearer test-token");
      expect(req?.headers.get("Content-Type")).toEqual("application/json");
      expect(req?.body).toEqual('{"plaintext":["plaintext"]}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("encrypt: empty array throws", async () => {
    const client = new CypherHttpClient("https://cypher.test", mockGetToken);
    const error = await client.encrypt([]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CypherError);
    expect((error as CypherError).message).toEqual("plaintext array cannot be empty");
    expect((error as CypherError).statusCode).toEqual(400);
    expect((error as CypherError).operation).toEqual("encrypt");
  });

  it("encrypt: 401 throws CypherAuthError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 401 }));

    try {
      const client = new CypherHttpClient("https://cypher.test", mockGetToken);
      const error = await client.encrypt(["secret"]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CypherAuthError);
      expect((error as CypherAuthError).statusCode).toEqual(401);
      expect((error as CypherAuthError).operation).toEqual("encrypt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("encrypt: 500 throws CypherError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 500 }));

    try {
      const client = new CypherHttpClient("https://cypher.test", mockGetToken);
      const error = await client.encrypt(["secret"]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CypherError);
      expect((error as CypherError).statusCode).toEqual(500);
      expect((error as CypherError).operation).toEqual("encrypt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("decrypt: success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ plaintext: ["decrypted1", "decrypted2"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    try {
      const client = new CypherHttpClient("https://cypher.test", mockGetToken);
      const result = await client.decrypt(["ct1", "ct2"]);
      expect(result).toEqual(["decrypted1", "decrypted2"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("decrypt: empty array throws", async () => {
    const client = new CypherHttpClient("https://cypher.test", mockGetToken);
    const error = await client.decrypt([]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CypherError);
    expect((error as CypherError).message).toEqual("ciphertext array cannot be empty");
    expect((error as CypherError).statusCode).toEqual(400);
    expect((error as CypherError).operation).toEqual("decrypt");
  });

  it("decrypt: 401 throws CypherAuthError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 401 }));

    try {
      const client = new CypherHttpClient("https://cypher.test", mockGetToken);
      const error = await client.decrypt(["ct"]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CypherAuthError);
      expect((error as CypherAuthError).statusCode).toEqual(401);
      expect((error as CypherAuthError).operation).toEqual("decrypt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("decrypt: 400 throws CypherDecryptError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 400 }));

    try {
      const client = new CypherHttpClient("https://cypher.test", mockGetToken);
      const error = await client.decrypt(["invalid"]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CypherDecryptError);
      expect((error as CypherDecryptError).statusCode).toEqual(400);
      expect((error as CypherDecryptError).operation).toEqual("decrypt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("decrypt: 500 throws CypherError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 500 }));

    try {
      const client = new CypherHttpClient("https://cypher.test", mockGetToken);
      const error = await client.decrypt(["ct"]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CypherError);
      expect((error as CypherError).statusCode).toEqual(500);
      expect((error as CypherError).operation).toEqual("decrypt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  describe("timeout tests", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("encrypt: timeout throws CypherTimeoutError", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
        // Simulate abort by returning a promise that rejects when signal is aborted
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const error = new Error("The operation was aborted");
              error.name = "AbortError";
              reject(error);
            });
          }
        });
      };

      const client = new CypherHttpClient("https://cypher.test", mockGetToken);

      // Create the promise and catch rejection immediately to track it
      let caughtError: unknown;
      const encryptPromise = client.encrypt(["secret"]).catch((e) => {
        caughtError = e;
      });

      // Advance time past the timeout and run all pending timers/microtasks
      await vi.runAllTimersAsync();
      await encryptPromise;

      expect(caughtError).toBeInstanceOf(CypherTimeoutError);
      expect((caughtError as CypherTimeoutError).statusCode).toEqual(408);
      expect((caughtError as CypherTimeoutError).operation).toEqual("encrypt");

      globalThis.fetch = originalFetch;
    });

    it("decrypt: timeout throws CypherTimeoutError", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const error = new Error("The operation was aborted");
              error.name = "AbortError";
              reject(error);
            });
          }
        });
      };

      const client = new CypherHttpClient("https://cypher.test", mockGetToken);

      // Create the promise and catch rejection immediately to track it
      let caughtError: unknown;
      const decryptPromise = client.decrypt(["ct"]).catch((e) => {
        caughtError = e;
      });

      // Advance time past the timeout and run all pending timers/microtasks
      await vi.runAllTimersAsync();
      await decryptPromise;

      expect(caughtError).toBeInstanceOf(CypherTimeoutError);
      expect((caughtError as CypherTimeoutError).statusCode).toEqual(408);
      expect((caughtError as CypherTimeoutError).operation).toEqual("decrypt");

      globalThis.fetch = originalFetch;
    });
  });
});
