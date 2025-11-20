/**
 * Abstract DocumentStore class
 */

import { logger } from "@atlas/logger";
import { z } from "zod";
import type { DocumentScope, StoredDocument } from "./types.ts";
import { StoredDocumentSchema } from "./types.ts";

export abstract class DocumentStore {
  protected logger = logger.child({ component: "document-store" });

  /** Create or update a document with schema validation */
  async write<TSchema extends z.ZodType>(
    scope: DocumentScope,
    type: string,
    id: string,
    data: unknown,
    schema: TSchema,
  ): Promise<StoredDocument<z.infer<TSchema>>> {
    // Validate data against schema
    let validatedData: z.infer<TSchema>;
    try {
      validatedData = schema.parse(data);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        this.logger.error("Document validation failed", {
          type,
          id,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
          error: z.prettifyError(error),
        });
      }
      throw error;
    }

    // Check if document exists to preserve creation time
    const rawExisting = await this.readRaw(scope, type, id);
    let createdAt = new Date().toISOString();

    if (rawExisting) {
      // Best effort to extract createdAt if it exists and is valid
      const result = StoredDocumentSchema.safeParse(rawExisting);
      if (result.success) {
        createdAt = result.data.createdAt;
      }
    }

    const now = new Date().toISOString();

    const doc: StoredDocument<z.infer<TSchema>> = {
      id,
      data: validatedData,
      createdAt,
      updatedAt: now,
    };

    await this.writeRaw(scope, type, id, doc);

    this.logger.debug("Document written", {
      type,
      id,
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
    });

    return doc;
  }

  /** Read a document with schema validation */
  async read<TSchema extends z.ZodType>(
    scope: DocumentScope,
    type: string,
    id: string,
    schema: TSchema,
  ): Promise<StoredDocument<z.infer<TSchema>> | null> {
    const rawDoc = await this.readRaw(scope, type, id);

    if (!rawDoc) {
      return null;
    }

    // Validate envelope structure
    const envelopeResult = StoredDocumentSchema.safeParse(rawDoc);
    if (!envelopeResult.success) {
      this.logger.error("Document envelope validation failed", {
        type,
        id,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        error: envelopeResult.error,
      });
      // Treat invalid envelope as corrupted/missing or throw?
      // Original behavior would throw if validation failed.
      // But here we are validating the storage format.
      throw new Error(`Invalid document structure in storage for ${type}/${id}`);
    }

    const doc = envelopeResult.data;

    // Validate document data against schema
    try {
      const validatedData = schema.parse(doc.data);
      return { ...doc, data: validatedData };
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        this.logger.error("Document validation failed on read", {
          type,
          id,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
          error: z.prettifyError(error),
        });
      }
      throw error;
    }
  }

  /** Delete a document */
  abstract delete(scope: DocumentScope, type: string, id: string): Promise<boolean>;

  /** Check if document exists */
  abstract exists(scope: DocumentScope, type: string, id: string): Promise<boolean>;

  /** List all document IDs of a type in scope */
  abstract list(scope: DocumentScope, type: string): Promise<string[]>;

  /** Raw read implementation */
  protected abstract readRaw(
    scope: DocumentScope,
    type: string,
    id: string,
  ): Promise<unknown | null>;

  /** Raw write implementation */
  protected abstract writeRaw(
    scope: DocumentScope,
    type: string,
    id: string,
    doc: StoredDocument,
  ): Promise<void>;

  /** Save execution state/metadata */
  abstract saveState(scope: DocumentScope, key: string, state: unknown): Promise<void>;

  /** Load execution state/metadata */
  abstract loadState(scope: DocumentScope, key: string): Promise<unknown | null>;
}
