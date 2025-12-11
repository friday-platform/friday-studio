import { assertEquals, assertRejects } from "@std/assert";
import {
  CypherAuthError,
  CypherDecryptError,
  CypherError,
  CypherHttpClient,
  CypherTimeoutError,
} from "./cypher-client.ts";

Deno.test("CypherHttpClient", async (t) => {
  const mockGetToken = () => Promise.resolve("test-token");

  await t.step("constructor validates baseUrl", () => {
    // Valid URLs
    new CypherHttpClient("https://cypher.test", mockGetToken);
    new CypherHttpClient("http://localhost:8085", mockGetToken);

    // Invalid URLs
    try {
      new CypherHttpClient("", mockGetToken);
      throw new Error("Should have thrown");
    } catch (e) {
      assertEquals((e as Error).message, "Invalid baseUrl: must be a valid HTTP(S) URL");
    }

    try {
      new CypherHttpClient("not-a-url", mockGetToken);
      throw new Error("Should have thrown");
    } catch (e) {
      assertEquals((e as Error).message, "Invalid baseUrl: must be a valid HTTP(S) URL");
    }
  });

  await t.step("encrypt: success", async () => {
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
      assertEquals(result, ["encrypted1", "encrypted2"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.step("encrypt: sends correct request", async () => {
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
      assertEquals(req?.url, "https://cypher.test/encrypt");
      assertEquals(req?.method, "POST");
      assertEquals(req?.headers.get("Authorization"), "Bearer test-token");
      assertEquals(req?.headers.get("Content-Type"), "application/json");
      assertEquals(req?.body, '{"plaintext":["plaintext"]}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.step("encrypt: empty array throws", async () => {
    const client = new CypherHttpClient("https://cypher.test", mockGetToken);
    const error = await assertRejects(() => client.encrypt([]), CypherError);
    assertEquals(error.message, "plaintext array cannot be empty");
    assertEquals(error.statusCode, 400);
    assertEquals(error.operation, "encrypt");
  });

  await t.step("encrypt: 401 throws CypherAuthError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 401 }));

    try {
      const client = new CypherHttpClient("https://cypher.test", mockGetToken);
      const error = await assertRejects(() => client.encrypt(["secret"]), CypherAuthError);
      assertEquals(error.statusCode, 401);
      assertEquals(error.operation, "encrypt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.step("encrypt: 500 throws CypherError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 500 }));

    try {
      const client = new CypherHttpClient("https://cypher.test", mockGetToken);
      const error = await assertRejects(() => client.encrypt(["secret"]), CypherError);
      assertEquals(error.statusCode, 500);
      assertEquals(error.operation, "encrypt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.step("decrypt: success", async () => {
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
      assertEquals(result, ["decrypted1", "decrypted2"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.step("decrypt: empty array throws", async () => {
    const client = new CypherHttpClient("https://cypher.test", mockGetToken);
    const error = await assertRejects(() => client.decrypt([]), CypherError);
    assertEquals(error.message, "ciphertext array cannot be empty");
    assertEquals(error.statusCode, 400);
    assertEquals(error.operation, "decrypt");
  });

  await t.step("decrypt: 401 throws CypherAuthError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 401 }));

    try {
      const client = new CypherHttpClient("https://cypher.test", mockGetToken);
      const error = await assertRejects(() => client.decrypt(["ct"]), CypherAuthError);
      assertEquals(error.statusCode, 401);
      assertEquals(error.operation, "decrypt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.step("decrypt: 400 throws CypherDecryptError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 400 }));

    try {
      const client = new CypherHttpClient("https://cypher.test", mockGetToken);
      const error = await assertRejects(() => client.decrypt(["invalid"]), CypherDecryptError);
      assertEquals(error.statusCode, 400);
      assertEquals(error.operation, "decrypt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.step("decrypt: 500 throws CypherError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 500 }));

    try {
      const client = new CypherHttpClient("https://cypher.test", mockGetToken);
      const error = await assertRejects(() => client.decrypt(["ct"]), CypherError);
      assertEquals(error.statusCode, 500);
      assertEquals(error.operation, "decrypt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.step("encrypt: timeout throws CypherTimeoutError", async () => {
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

    try {
      const client = new CypherHttpClient("https://cypher.test", mockGetToken);
      const error = await assertRejects(() => client.encrypt(["secret"]), CypherTimeoutError);
      assertEquals(error.statusCode, 408);
      assertEquals(error.operation, "encrypt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.step("decrypt: timeout throws CypherTimeoutError", async () => {
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

    try {
      const client = new CypherHttpClient("https://cypher.test", mockGetToken);
      const error = await assertRejects(() => client.decrypt(["ct"]), CypherTimeoutError);
      assertEquals(error.statusCode, 408);
      assertEquals(error.operation, "decrypt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
