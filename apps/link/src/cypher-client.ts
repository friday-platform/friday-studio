import { z } from "zod";

/** Response schema for /encrypt endpoint */
const EncryptResponseSchema = z.object({ ciphertext: z.array(z.string()) });

/** Response schema for /decrypt endpoint */
const DecryptResponseSchema = z.object({ plaintext: z.array(z.string()) });

/**
 * Base error for Cypher service failures.
 */
export class CypherError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly operation: "encrypt" | "decrypt",
  ) {
    super(message);
    this.name = "CypherError";
  }
}

/** Authentication failure (401). */
export class CypherAuthError extends CypherError {
  constructor(operation: "encrypt" | "decrypt") {
    super("Authentication failed", 401, operation);
    this.name = "CypherAuthError";
  }
}

/** Decryption failure (400) - typically invalid ciphertext or wrong key. */
export class CypherDecryptError extends CypherError {
  constructor() {
    super("Decryption failed", 400, "decrypt");
    this.name = "CypherDecryptError";
  }
}

/** Timeout error for Cypher service requests. */
export class CypherTimeoutError extends CypherError {
  constructor(operation: "encrypt" | "decrypt") {
    super(`Cypher ${operation} timed out`, 408, operation);
    this.name = "CypherTimeoutError";
  }
}

/** Default timeout for Cypher requests (5 seconds) */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Interface for encryption/decryption operations.
 */
export interface CypherClient {
  encrypt(plaintext: string[]): Promise<string[]>;
  decrypt(ciphertext: string[]): Promise<string[]>;
}

/**
 * HTTP client for the Cypher encryption service.
 *
 * Cypher provides per-user AEAD encryption using Google Tink with AES-256-GCM.
 * The user ID is extracted from the JWT token by the Cypher service.
 */
export class CypherHttpClient implements CypherClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly getAuthToken: () => Promise<string>,
  ) {
    if (!baseUrl || !baseUrl.startsWith("http")) {
      throw new Error("Invalid baseUrl: must be a valid HTTP(S) URL");
    }
    // Normalize: remove trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Common request logic for encrypt/decrypt endpoints */
  private async request<T>(
    endpoint: string,
    body: Record<string, unknown>,
    schema: z.ZodSchema<T>,
    operation: "encrypt" | "decrypt",
  ): Promise<T> {
    const token = await this.getAuthToken();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new CypherTimeoutError(operation);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 401) throw new CypherAuthError(operation);
    if (operation === "decrypt" && response.status === 400) throw new CypherDecryptError();
    if (!response.ok) {
      throw new CypherError(
        `Cypher ${operation} failed: ${response.status}`,
        response.status,
        operation,
      );
    }

    return schema.parse(await response.json());
  }

  async encrypt(plaintext: string[]): Promise<string[]> {
    if (plaintext.length === 0) {
      throw new CypherError("plaintext array cannot be empty", 400, "encrypt");
    }
    const result = await this.request("encrypt", { plaintext }, EncryptResponseSchema, "encrypt");
    return result.ciphertext;
  }

  async decrypt(ciphertext: string[]): Promise<string[]> {
    if (ciphertext.length === 0) {
      throw new CypherError("ciphertext array cannot be empty", 400, "decrypt");
    }
    const result = await this.request("decrypt", { ciphertext }, DecryptResponseSchema, "decrypt");
    return result.plaintext;
  }
}
