import { createLogger } from "@atlas/logger";
import { Hono } from "hono";

const logger = createLogger({ name: "gcs-mock" });

/**
 * Mock GCS server that implements minimal GCS API for Cortex blob storage.
 * Provides in-memory storage for testing without actual GCS infrastructure.
 */
export class MockGCSServer {
  private app: Hono;
  private server: Deno.HttpServer | null = null;
  private storage = new Map<string, Uint8Array>(); // In-memory blob storage

  constructor(private readonly port = 4443) {
    this.app = new Hono();
    this.setupRoutes();
  }

  private setupRoutes() {
    // Multipart upload (POST /upload/storage/v1/b/:bucket/o - used by Go SDK)
    this.app.post("/upload/storage/v1/b/:bucket/o", async (c) => {
      const bucket = c.req.param("bucket");
      const name = c.req.query("name");

      if (!name) {
        return c.json({ error: "Missing name parameter" }, 400);
      }

      // Get raw body and Content-Type header
      const body = await c.req.arrayBuffer();
      const contentType = c.req.header("Content-Type") || "";

      let fileContent: Uint8Array;

      // Parse multipart/related format used by Go SDK
      // Format: Part 1 = JSON metadata, Part 2 = actual file content
      if (contentType.includes("multipart/")) {
        // Extract boundary from Content-Type header
        const boundaryMatch = contentType.match(/boundary=([^;]+)/);
        if (boundaryMatch) {
          const boundary = boundaryMatch[1];
          const bodyText = new TextDecoder().decode(new Uint8Array(body));

          // Find the content parts between boundaries
          const parts = bodyText.split(`--${boundary}`);
          let partIndex = 0;
          for (const part of parts) {
            if (part.includes("\r\n\r\n") || part.includes("\n\n")) {
              // Split headers from content
              const separator = part.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
              const contentStart = part.indexOf(separator);
              if (contentStart >= 0) {
                const content = part.substring(contentStart + separator.length).trim();
                if (content && !content.startsWith("--")) {
                  // Part 0 = metadata (JSON with bucket/name), Part 1 = actual media content
                  if (partIndex === 1) {
                    // This is the media part - the actual file content we want
                    fileContent = new TextEncoder().encode(content);
                    break;
                  }
                  partIndex++;
                }
              }
            }
          }
        }
      }

      // If multipart parsing failed or no multipart, use raw body
      if (!fileContent!) {
        fileContent = new Uint8Array(body);
      }

      // Unwrap Cortex {"content": "..."} wrapper if present
      try {
        const contentStr = new TextDecoder().decode(fileContent);
        const contentJson: unknown = JSON.parse(contentStr);
        if (
          contentJson &&
          typeof contentJson === "object" &&
          "content" in contentJson &&
          typeof contentJson.content === "string"
        ) {
          // Extract the actual content from the wrapper
          fileContent = new TextEncoder().encode(contentJson.content);
        }
      } catch {
        // Not JSON or no content field - use as is
      }

      const key = `${bucket}/${name}`;
      this.storage.set(key, fileContent);

      logger.debug("GCS multipart upload", { key, size: fileContent.byteLength });

      return c.json({
        kind: "storage#object",
        id: key,
        name: name,
        bucket: bucket,
        size: fileContent.byteLength.toString(),
      });
    });

    // Upload object (PUT /storage/v1/b/:bucket/o/*)
    this.app.put("/storage/v1/b/:bucket/o/*", async (c) => {
      const bucket = c.req.param("bucket");
      const object = c.req.param("*"); // Wildcard captures full path including slashes
      const body = await c.req.arrayBuffer();

      const key = `${bucket}/${object}`;
      this.storage.set(key, new Uint8Array(body));

      logger.debug("GCS PUT", { key, size: body.byteLength });

      return c.json({
        kind: "storage#object",
        id: key,
        name: object,
        bucket: bucket,
        size: body.byteLength.toString(),
      });
    });

    // Download object (GET /storage/v1/b/:bucket/o/*)
    // Handles paths with slashes using wildcard
    this.app.get("/storage/v1/b/:bucket/o/*", (c) => {
      const bucket = c.req.param("bucket");
      const object = c.req.param("*"); // Wildcard captures full path including slashes

      const key = `${bucket}/${object}`;
      const data = this.storage.get(key);

      if (!data) {
        logger.debug("GCS GET 404", { key });
        return c.json({ error: "Not found" }, 404);
      }

      logger.debug("GCS GET 200", { key, size: data.byteLength });
      // Create a new Uint8Array with ArrayBuffer (not SharedArrayBuffer)
      return new Response(new Uint8Array(data));
    });

    // Download object via media endpoint (used by Go SDK)
    this.app.get("/download/storage/v1/b/:bucket/o/*", (c) => {
      const bucket = c.req.param("bucket");
      const object = c.req.param("*"); // Wildcard captures the rest of the path

      const key = `${bucket}/${object}`;
      const data = this.storage.get(key);

      if (!data) {
        logger.debug("GCS download 404", { key });
        return c.json({ error: "Not found" }, 404);
      }

      logger.debug("GCS download 200", { key, size: data.byteLength });
      return new Response(new Uint8Array(data));
    });

    // Delete object (DELETE /storage/v1/b/:bucket/o/*)
    this.app.delete("/storage/v1/b/:bucket/o/*", (c) => {
      const bucket = c.req.param("bucket");
      const object = c.req.param("*"); // Wildcard captures full path including slashes
      const key = `${bucket}/${object}`;

      this.storage.delete(key);
      logger.debug("GCS DELETE", { key });

      return c.newResponse(null, { status: 204 });
    });

    // Health check
    this.app.get("/health", (c) => c.json({ status: "ok" }));

    // STORAGE_EMULATOR_HOST format: /:bucket/:object (simplified paths)
    // When using STORAGE_EMULATOR_HOST, Go SDK makes requests to /<bucket>/<object>
    // The object path may be URL-encoded and contain slashes
    this.app.get("/:bucket/:object{.+}", (c) => {
      const bucket = c.req.param("bucket");
      // Skip health check route
      if (bucket === "health") {
        return c.json({ error: "Not found" }, 404);
      }

      // Regex pattern {.+} captures everything after bucket, including slashes
      // The object path may be URL-encoded
      const encodedObject = c.req.param("object");
      const object = decodeURIComponent(encodedObject);

      const key = `${bucket}/${object}`;
      const data = this.storage.get(key);

      if (!data) {
        logger.debug("GCS emulator GET 404", { key });
        return c.json({ error: "Not found" }, 404);
      }

      logger.debug("GCS emulator GET 200", { key, size: data.byteLength });
      return new Response(new Uint8Array(data));
    });

    // STORAGE_EMULATOR_HOST format: POST /:bucket/:object (upload)
    this.app.post("/:bucket/:object{.+}", async (c) => {
      const bucket = c.req.param("bucket");
      const encodedObject = c.req.param("object");
      const object = decodeURIComponent(encodedObject);
      const body = await c.req.arrayBuffer();

      const key = `${bucket}/${object}`;
      this.storage.set(key, new Uint8Array(body));

      logger.debug("GCS emulator POST", { key, size: body.byteLength });

      return c.json({
        kind: "storage#object",
        id: key,
        name: object,
        bucket: bucket,
        size: body.byteLength.toString(),
      });
    });
  }

  start(): void {
    this.server = Deno.serve({ port: this.port, onListen: () => {} }, this.app.fetch);
    logger.info("Mock GCS server started", { port: this.port });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.shutdown();
      this.server = null;
      logger.info("Mock GCS server stopped");
    }
  }

  /**
   * Reset storage state (clear all blobs).
   */
  reset(): void {
    this.storage.clear();
    logger.debug("Mock GCS storage cleared");
  }

  /**
   * Get list of stored blob keys for testing.
   */
  getStoredBlobs(): string[] {
    return Array.from(this.storage.keys());
  }

  /**
   * Get size of a stored blob.
   */
  getBlobSize(bucket: string, object: string): number {
    const key = `${bucket}/${object}`;
    const data = this.storage.get(key);
    return data?.byteLength ?? 0;
  }

  /**
   * Check if a blob exists.
   */
  hasBlob(bucket: string, object: string): boolean {
    const key = `${bucket}/${object}`;
    return this.storage.has(key);
  }
}
