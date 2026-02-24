/// <reference lib="deno.unstable" />

/**
 * Deno KV Storage Implementation
 *
 * This implementation completely hides Deno.Kv types behind the KVStorage interface,
 * ensuring that no storage-specific types leak into the business logic layer.
 */

import { mkdir } from "node:fs/promises";
import {
  type AtomicOperation,
  KVConnectionError,
  type KVStorage,
  KVStorageError,
  KVTransactionError,
} from "./kv-storage.ts";

/**
 * Deno KV implementation of AtomicOperation
 * Wraps Deno.AtomicOperation without exposing its types
 */
class DenoKVAtomicOperation implements AtomicOperation {
  constructor(private operation: Deno.AtomicOperation) {}

  set<T>(key: string[], value: T) {
    this.operation = this.operation.set(key, value);
    return this;
  }

  delete(key: string[]) {
    this.operation = this.operation.delete(key);
    return this;
  }

  check<T>(key: string[], expectedValue: T | null) {
    // Store check for validation during commit
    // Deno KV check API requires a KvEntryMaybe object
    const checkEntry = { key, value: expectedValue, versionstamp: null };
    this.operation = this.operation.check(checkEntry);
    return this;
  }

  async commit() {
    try {
      const result = await this.operation.commit();
      return result.ok;
    } catch (error) {
      throw new KVTransactionError(
        `Failed to commit atomic operation: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}

type StorageState = "uninitialized" | "initializing" | "ready" | "closed";

/**
 * Deno KV Storage Implementation
 *
 * Provides a clean KVStorage interface over Deno.Kv, completely hiding
 * Deno-specific types and APIs from the rest of the application.
 */
export class DenoKVStorage implements KVStorage {
  private kv: Deno.Kv | null = null;
  private path?: string;
  private state: StorageState = "uninitialized";
  private initializationPromise: Promise<void> | null = null;

  constructor(path?: string) {
    this.path = path;
  }

  async initialize() {
    switch (this.state) {
      case "ready":
        return; // Already initialized

      case "initializing":
        // If already initializing, wait for the existing initialization to complete
        if (this.initializationPromise) {
          return this.initializationPromise;
        }
        throw new Error("Storage is initializing but no promise is available");

      case "closed":
        throw new KVStorageError(
          "Storage has been closed and cannot be reinitialized",
          "STORAGE_CLOSED",
        );

      case "uninitialized":
        // Proceed with initialization
        break;
    }

    // Set state and create initialization promise
    this.state = "initializing";
    this.initializationPromise = this.doInitialize();

    try {
      await this.initializationPromise;
    } finally {
      // Clear the promise after completion (success or failure)
      this.initializationPromise = null;
    }
  }

  private async doInitialize() {
    try {
      // Ensure parent directory exists for file-based KV
      if (this.path) {
        const dir = this.path.substring(0, this.path.lastIndexOf("/"));
        if (dir) {
          await mkdir(dir, { recursive: true });
        }
      }

      this.kv = await Deno.openKv(this.path);
      this.state = "ready";
    } catch (error) {
      // Reset state on failure
      this.state = "uninitialized";
      throw new KVConnectionError(
        `Failed to initialize Deno KV storage at ${this.path || "default location"}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private ensureReady() {
    if (this.state !== "ready") {
      throw new KVStorageError(
        `Storage is not ready (current state: ${this.state})`,
        "NOT_INITIALIZED",
      );
    }
    if (!this.kv) {
      throw new KVStorageError(
        "Storage is in ready state but KV instance is missing",
        "INVALID_STATE",
      );
    }
  }

  async get<T>(key: string[]) {
    this.ensureReady();
    if (!this.kv) {
      throw new Error("KV is not ready");
    }
    try {
      const result = await this.kv.get<T>(key);
      return result.value;
    } catch (error) {
      throw new KVStorageError(
        `Failed to get key [${key.join(", ")}]: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GET_FAILED",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async set<T>(key: string[], value: T): Promise<void> {
    this.ensureReady();
    if (!this.kv) {
      throw new Error("KV is not ready");
    }
    try {
      await this.kv.set(key, value);
    } catch (error) {
      throw new KVStorageError(
        `Failed to set key [${key.join(", ")}]: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "SET_FAILED",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async delete(key: string[]) {
    this.ensureReady();
    if (!this.kv) {
      throw new Error("KV is not ready");
    }
    try {
      await this.kv.delete(key);
    } catch (error) {
      throw new KVStorageError(
        `Failed to delete key [${key.join(", ")}]: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "DELETE_FAILED",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  // @ts-expect-error issue with narrowing Deno.KVKey in the `*list` asyncIterator.
  async *list<T>(prefix: string[]) {
    this.ensureReady();
    if (!this.kv) {
      throw new Error("KV is not ready");
    }
    try {
      const iter = this.kv.list<T>({ prefix });

      for await (const entry of iter) {
        yield { key: entry.key, value: entry.value, versionstamp: entry.versionstamp };
      }
    } catch (error) {
      throw new KVStorageError(
        `Failed to list entries with prefix [${prefix.join(", ")}]: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "LIST_FAILED",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  atomic(): AtomicOperation {
    this.ensureReady();
    if (!this.kv) {
      throw new Error("KV is not ready");
    }
    return new DenoKVAtomicOperation(this.kv.atomic());
  }

  async health() {
    if (this.state !== "ready" || !this.kv) {
      return false;
    }

    try {
      // Perform a simple health check by attempting to get a non-existent key
      await this.kv.get(["__health_check__"]);
      return true;
    } catch {
      return false;
    }
  }

  async close() {
    if (this.state === "closed") {
      return; // Already closed
    }

    if (this.state === "initializing" && this.initializationPromise) {
      // Wait for initialization to complete before closing
      await this.initializationPromise.catch(() => {}); // Ignore initialization errors
    }

    if (this.kv) {
      try {
        this.kv.close();
        this.kv = null;
      } catch (error) {
        throw new KVStorageError(
          `Failed to close storage: ${error instanceof Error ? error.message : String(error)}`,
          "CLOSE_FAILED",
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    this.state = "closed";
  }
}
