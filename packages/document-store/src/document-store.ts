/**
 * Abstract DocumentStore class
 *
 * All public methods return Result<T, string> for consistent error handling.
 * Validation failures are returned as Result errors, not thrown.
 */

import { logger } from "@atlas/logger";
import { fail, type Result, success } from "@atlas/utils";
import { z } from "zod";
import type { DocumentScope, StoredDocument } from "./types.ts";
import { StoredDocumentSchema } from "./types.ts";

export abstract class DocumentStore {
  protected logger = logger.child({ component: "document-store" });

  /** Create or update a document with schema validation */
  async write<T>(
    scope: DocumentScope,
    type: string,
    id: string,
    data: unknown,
    schema: z.ZodType<T>,
  ): Promise<Result<StoredDocument<T>, string>> {
    // Validate data against schema
    const parseResult = schema.safeParse(data);
    if (!parseResult.success) {
      const msg =
        parseResult.error instanceof z.ZodError
          ? z.prettifyError(parseResult.error)
          : String(parseResult.error);
      this.logger.error("Document validation failed", {
        type,
        id,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        error: msg,
      });
      return fail(`Document validation failed for ${type}/${id}: ${msg}`);
    }

    const validatedData: T = parseResult.data;

    // Check if document exists to preserve creation time
    const rawExisting = await this.readRaw(scope, type, id);
    let createdAt = new Date().toISOString();

    if (rawExisting) {
      // Best effort to extract createdAt if it exists and is valid
      const envelopeResult = StoredDocumentSchema.safeParse(rawExisting);
      if (envelopeResult.success) {
        createdAt = envelopeResult.data.createdAt;
      }
    }

    const now = new Date().toISOString();

    const doc: StoredDocument<T> = { id, data: validatedData, createdAt, updatedAt: now };

    await this.writeRaw(scope, type, id, doc);

    this.logger.debug("Document written", {
      type,
      id,
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
    });

    return success(doc);
  }

  /** Read a document with schema validation */
  async read<T>(
    scope: DocumentScope,
    type: string,
    id: string,
    schema: z.ZodType<T>,
  ): Promise<Result<StoredDocument<T> | null, string>> {
    const rawDoc = await this.readRaw(scope, type, id);

    if (!rawDoc) {
      return success(null);
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
      return fail(`Invalid document structure in storage for ${type}/${id}`);
    }

    const doc = envelopeResult.data;

    // Validate document data against schema
    const dataResult = schema.safeParse(doc.data);
    if (!dataResult.success) {
      const msg =
        dataResult.error instanceof z.ZodError
          ? z.prettifyError(dataResult.error)
          : String(dataResult.error);
      this.logger.error("Document validation failed on read", {
        type,
        id,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        error: msg,
      });
      return fail(`Document data validation failed for ${type}/${id}: ${msg}`);
    }

    return success({ ...doc, data: dataResult.data });
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

  /** Save execution state/metadata with optional schema validation */
  async saveState(
    scope: DocumentScope,
    key: string,
    state: unknown,
    schema?: z.ZodType,
  ): Promise<Result<void, string>> {
    if (schema) {
      const parseResult = schema.safeParse(state);
      if (!parseResult.success) {
        const msg =
          parseResult.error instanceof z.ZodError
            ? z.prettifyError(parseResult.error)
            : String(parseResult.error);
        this.logger.error("State validation failed on save", {
          key,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
          error: msg,
        });
        return fail(`State validation failed for ${key}: ${msg}`);
      }
    }
    await this.saveStateRaw(scope, key, state);
    return success(undefined);
  }

  /** Load execution state/metadata with schema validation */
  async loadState<T>(
    scope: DocumentScope,
    key: string,
    schema: z.ZodType<T>,
  ): Promise<Result<T | null, string>>;
  /** Load execution state/metadata without validation */
  async loadState(scope: DocumentScope, key: string): Promise<Result<unknown | null, string>>;
  async loadState(
    scope: DocumentScope,
    key: string,
    schema?: z.ZodType,
  ): Promise<Result<unknown | null, string>> {
    const raw = await this.loadStateRaw(scope, key);
    if (raw === null || raw === undefined) {
      return success(null);
    }

    if (schema) {
      const parseResult = schema.safeParse(raw);
      if (!parseResult.success) {
        const msg =
          parseResult.error instanceof z.ZodError
            ? z.prettifyError(parseResult.error)
            : String(parseResult.error);
        this.logger.error("State validation failed on load", {
          key,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
          error: msg,
        });
        return fail(`State validation failed for ${key}: ${msg}`);
      }
      return success(parseResult.data);
    }

    return success(raw);
  }

  /** Raw state save implementation */
  protected abstract saveStateRaw(scope: DocumentScope, key: string, state: unknown): Promise<void>;

  /** Raw state load implementation */
  protected abstract loadStateRaw(scope: DocumentScope, key: string): Promise<unknown | null>;
}
