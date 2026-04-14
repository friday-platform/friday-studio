import type { NarrativeEntry, ScratchpadAdapter, ScratchpadChunk } from "@atlas/agent-sdk";
import { ScratchpadChunkSchema, withSchemaBoundary } from "@atlas/agent-sdk";

export class NotImplementedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NotImplementedError";
  }
}

export class InMemoryScratchpadAdapter implements ScratchpadAdapter {
  private store = new Map<string, ScratchpadChunk[]>();

  async append(sessionKey: string, chunk: ScratchpadChunk): Promise<void> {
    await withSchemaBoundary(
      {
        schema: ScratchpadChunkSchema,
        commit: (parsed: ScratchpadChunk) => {
          const chunks = this.store.get(sessionKey);
          if (chunks) {
            chunks.push(parsed);
          } else {
            this.store.set(sessionKey, [parsed]);
          }
          return Promise.resolve(parsed);
        },
      },
      chunk,
    );
  }

  // deno-lint-ignore require-await
  async read(sessionKey: string, opts?: { since?: string }): Promise<ScratchpadChunk[]> {
    const chunks = this.store.get(sessionKey) ?? [];
    const since = opts?.since;
    if (since) {
      return chunks.filter((c) => c.createdAt >= since);
    }
    return chunks;
  }

  // deno-lint-ignore require-await
  async clear(sessionKey: string): Promise<void> {
    this.store.delete(sessionKey);
  }

  // deno-lint-ignore require-await
  async promote(
    _sessionKey: string,
    _chunkId: string,
    _target: { workspaceId: string; corpus: string },
  ): Promise<NarrativeEntry> {
    throw new NotImplementedError(
      "promote() requires NarrativeCorpus injection — out of scope for in-memory adapter",
    );
  }
}
