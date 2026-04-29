/**
 * Filesystem implementation of DocumentStore
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isErrnoException } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { DocumentStore } from "./document-store.ts";
import type { DocumentScope, StoredDocument } from "./types.ts";

export interface FileSystemDocumentStoreOptions {
  /** Base storage path. Defaults to ~/.atlas/workspaces */
  basePath?: string;
}

export class FileSystemDocumentStore extends DocumentStore {
  private basePath: string;

  constructor(options: FileSystemDocumentStoreOptions = {}) {
    super();
    this.basePath = options.basePath || join(getFridayHome(), "workspaces");
  }

  /** Build file path for a document */
  private buildPath(scope: DocumentScope, type: string, id: string): string {
    if (scope.sessionId) {
      // Session-scoped: ~/.atlas/workspaces/{workspaceId}/sessions/{sessionId}/{type}/{id}.json
      return join(
        this.basePath,
        scope.workspaceId,
        "sessions",
        scope.sessionId,
        type,
        `${id}.json`,
      );
    }

    // Workspace-scoped: ~/.atlas/workspaces/{workspaceId}/{type}/{id}.json
    return join(this.basePath, scope.workspaceId, type, `${id}.json`);
  }

  async delete(scope: DocumentScope, type: string, id: string): Promise<boolean> {
    const path = this.buildPath(scope, type, id);

    try {
      await rm(path);
      this.logger.debug("Document deleted", {
        type,
        id,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        path,
      });
      return true;
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async exists(scope: DocumentScope, type: string, id: string): Promise<boolean> {
    const path = this.buildPath(scope, type, id);
    try {
      await stat(path);
      return true;
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async list(scope: DocumentScope, type: string): Promise<string[]> {
    const dirPath = scope.sessionId
      ? join(this.basePath, scope.workspaceId, "sessions", scope.sessionId, type)
      : join(this.basePath, scope.workspaceId, type);

    try {
      const ids: string[] = [];
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          ids.push(entry.name.replace(".json", ""));
        }
      }
      return ids;
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  protected async readRaw(scope: DocumentScope, type: string, id: string): Promise<unknown | null> {
    const path = this.buildPath(scope, type, id);
    try {
      const content = await readFile(path, "utf-8");
      if (!content.trim()) {
        return null;
      }
      return JSON.parse(content);
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return null;
      }
      if (error instanceof SyntaxError) {
        this.logger.warn("Corrupted JSON document file, treating as non-existent", {
          path: this.buildPath(scope, type, id),
          type,
          id,
        });
        return null;
      }
      throw error;
    }
  }

  protected async writeRaw(
    scope: DocumentScope,
    type: string,
    id: string,
    doc: StoredDocument,
  ): Promise<void> {
    const path = this.buildPath(scope, type, id);
    await mkdir(join(path, ".."), { recursive: true });

    await writeFile(path, JSON.stringify(doc, null, 2), "utf-8");

    this.logger.debug("Document written to filesystem", {
      type,
      id,
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      path,
    });
  }

  protected async saveStateRaw(scope: DocumentScope, key: string, state: unknown): Promise<void> {
    const path = this.buildStatePath(scope, key);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
  }

  protected async loadStateRaw(scope: DocumentScope, key: string): Promise<unknown | null> {
    const path = this.buildStatePath(scope, key);
    try {
      const content = await readFile(path, "utf-8");
      if (!content.trim()) {
        return null;
      }
      return JSON.parse(content);
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private buildStatePath(scope: DocumentScope, key: string): string {
    if (scope.sessionId) {
      return join(
        this.basePath,
        scope.workspaceId,
        "sessions",
        scope.sessionId,
        `_state_${key}.json`,
      );
    }
    return join(this.basePath, scope.workspaceId, `_state_${key}.json`);
  }
}
