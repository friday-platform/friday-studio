/**
 * Hybrid RAG knowledge agent: BM25 + Vector + Reranker + LLM synthesis.
 *
 * All retrieval happens BEFORE the LLM call — single round-trip.
 * Uses pre-built corpus.db (created by corpus.ts).
 */
import process from "node:process";
import { createAgent, err, ok } from "@atlas/agent-sdk";
import { getDefaultProviderOpts, registry, traceModel } from "@atlas/llm";
import { stringifyError } from "@atlas/utils";
import { Database } from "@db/sqlite";
import { generateText } from "ai";
import { buildCorpus } from "./corpus.ts";
import { buildHybridPrompt } from "./prompts.ts";
import { rerank } from "./rerank.ts";
import {
  type EmbeddingCache,
  hybridSearch,
  invalidateEmbeddingCache,
  loadEmbeddings,
} from "./search.ts";
import { KnowledgeOutputSchema, type KnowledgeResult, type KnowledgeSource } from "./shared.ts";

/**
 * Check if the agent context contains a build/reindex config.
 * The FSM's prepare_build function sets config.data_dir.
 */
function isBuildRequest(config?: Record<string, unknown>): { isBuild: boolean; dataDir?: string } {
  const dataDir = config?.data_dir;
  if (typeof dataDir === "string" && dataDir.length > 0) {
    return { isBuild: true, dataDir };
  }
  return { isBuild: false };
}

export const knowledgeHybridAgent = createAgent<string, KnowledgeResult>({
  id: "knowledge-hybrid",
  displayName: "Knowledge (Hybrid RAG)",
  version: "1.0.0",
  summary:
    "Hybrid retrieval agent: BM25 + vector search + reranker. Requires a pre-built corpus.db.",
  description:
    "Knowledge agent using hybrid RAG: BM25 full-text search (SQLite FTS5) combined with " +
    "vector similarity search, merged via Reciprocal Rank Fusion, reranked by LLM cross-encoder, " +
    "and synthesized into a structured CS briefing. Single LLM round-trip.",
  constraints:
    "Read-only. Requires KNOWLEDGE_CORPUS_PATH pointing to a pre-built corpus.db file " +
    "(created by corpus.ts). Requires FIREWORKS_API_KEY for query embedding and " +
    "GROQ_API_KEY for reranking (optional, degrades gracefully).",
  outputSchema: KnowledgeOutputSchema,
  useWorkspaceSkills: true,
  expertise: {
    examples: [
      "How do I make Eggs Benedict?",
      "What chocolate dessert recipes are available?",
      "Find soup recipes that use beans",
      "How was this issue resolved in the past?",
    ],
  },
  environment: {
    required: [
      {
        name: "KNOWLEDGE_CORPUS_PATH",
        description: "Path to pre-built corpus.db file (created by corpus.ts)",
      },
      {
        name: "FIREWORKS_API_KEY",
        description: "Fireworks API key for query embedding (nomic-embed-text-v1.5)",
      },
    ],
    optional: [
      {
        name: "GROQ_API_KEY",
        description: "Groq API key for reranking (degrades gracefully without it)",
      },
      {
        name: "KNOWLEDGE_DATA_DIR",
        description: "Path to directory containing source files for corpus building",
      },
    ],
  },

  handler: async (prompt, { logger, stream, abortSignal, env, config, skills }) => {
    const startTime = performance.now();
    const corpusPath = env.KNOWLEDGE_CORPUS_PATH ?? process.env.KNOWLEDGE_CORPUS_PATH;

    if (!corpusPath) {
      return err("KNOWLEDGE_CORPUS_PATH environment variable is required");
    }

    // Check if this is a build/reindex request (config.data_dir set by FSM prepare_build)
    const buildCheck = isBuildRequest(config);
    if (buildCheck.isBuild) {
      const dataDir =
        buildCheck.dataDir ?? env.KNOWLEDGE_DATA_DIR ?? process.env.KNOWLEDGE_DATA_DIR;

      if (!dataDir) {
        return err(
          "data_dir is required for reindexing — provide it in the signal input or set KNOWLEDGE_DATA_DIR env var",
        );
      }

      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Knowledge (Hybrid)", content: `Building corpus from ${dataDir}...` },
      });

      try {
        const result = await buildCorpus({
          inputPath: dataDir,
          outputPath: corpusPath,
          onProgress: (phase, done, total) => {
            stream?.emit({
              type: "data-tool-progress",
              data: { toolName: "Knowledge (Hybrid)", content: `${phase}: ${done}/${total}` },
            });
          },
        });

        const sourceLines = result.sources
          .map((s) => `- **${s.file}** (${s.type}): ${s.count} documents`)
          .join("\n");
        const summary = [
          "## Corpus Built Successfully",
          "",
          `- **Documents indexed:** ${result.documentCount}`,
          `- **Embeddings generated:** ${result.embeddedCount}`,
          `- **Duration:** ${(result.durationMs / 1000).toFixed(1)}s`,
          `- **Output:** ${corpusPath}`,
          "",
          "### Sources",
          sourceLines,
        ].join("\n");

        invalidateEmbeddingCache();
        logger.info("Corpus build complete", {
          documentCount: result.documentCount,
          embeddedCount: result.embeddedCount,
          durationMs: result.durationMs,
          sources: result.sources,
        });

        return ok({ response: summary, sources: [] });
      } catch (error) {
        logger.error("Corpus build failed", { error, dataDir });
        return err(stringifyError(error));
      }
    }

    // Extract the actual search query from config (FSM passes it via prepare_query).
    // The raw `prompt` includes FSM context metadata (timestamps, signal data) which
    // pollutes BM25 search — use config.question for retrieval, config.context (if
    // provided) + question for LLM synthesis.
    const searchQuery =
      typeof config?.question === "string" && config.question.length > 0 ? config.question : prompt;

    // Optional context (e.g., full ticket conversation) to include in LLM synthesis
    // without polluting the search query.
    const synthesisContext =
      typeof config?.context === "string" && config.context.length > 0 ? config.context : undefined;
    const synthesisQuery = synthesisContext
      ? `${synthesisContext}\n\nQuestion: ${searchQuery}`
      : searchQuery;

    // Phase 1: Open corpus (query mode)
    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Knowledge (Hybrid)", content: "Loading corpus..." },
    });

    let db: Database | undefined;
    let embeddingCache: EmbeddingCache;
    try {
      const loadStart = performance.now();
      db = new Database(corpusPath, { readonly: true });
      embeddingCache = loadEmbeddings(db, corpusPath);
      const loadMs = Math.round(performance.now() - loadStart);
      logger.info("Corpus loaded", { documents: embeddingCache.ids.length, corpusPath, loadMs });
      stream?.emit({
        type: "data-tool-progress",
        data: {
          toolName: "Knowledge (Hybrid)",
          content: `Corpus loaded (${loadMs}ms, ${embeddingCache.ids.length} docs)`,
        },
      });
    } catch (error) {
      logger.error("Failed to open corpus", { error, corpusPath });
      // Close db if openDatabase succeeded but loadEmbeddings failed
      if (db) db.close();
      return err(stringifyError(error));
    }

    try {
      // Phase 2: Hybrid search
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Knowledge (Hybrid)", content: "Searching (BM25 + vector)..." },
      });

      const searchStart = performance.now();
      const {
        results: candidates,
        bm25Count,
        vecCount,
        bm25Error,
      } = await hybridSearch(searchQuery, db, embeddingCache, { env });
      const searchMs = Math.round(performance.now() - searchStart);
      const candidateKb = candidates.filter(
        (r) => r.sourceType === "knowledge_base" || r.sourceType === "confluence",
      ).length;
      logger.info("Hybrid search complete", {
        bm25Count,
        vecCount,
        candidatesAfterRRF: candidates.length,
        kbArticlesInCandidates: candidateKb,
        searchMs,
      });
      const bm25Info = bm25Error ? ` [ERROR: ${bm25Error}]` : "";
      stream?.emit({
        type: "data-tool-progress",
        data: {
          toolName: "Knowledge (Hybrid)",
          content: `Search (${searchMs}ms): ${bm25Count} BM25${bm25Info} + ${vecCount} vector → ${candidates.length} candidates (${candidateKb} KB)`,
        },
      });

      if (candidates.length === 0) {
        return ok({ response: "No relevant results found in the knowledge base.", sources: [] });
      }

      // Phase 3: Rerank
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Knowledge (Hybrid)", content: "Reranking results..." },
      });

      const rerankStart = performance.now();
      const rerankResult = await rerank(searchQuery, candidates, 7, env);
      const rerankMs = Math.round(performance.now() - rerankStart);
      const reranked = rerankResult.results;
      const rerankedKb = reranked.filter(
        (r) => r.sourceType === "knowledge_base" || r.sourceType === "confluence",
      ).length;
      if (rerankResult.error) {
        logger.warn("Reranker issue", { error: rerankResult.error });
      }
      logger.info("Reranking complete", {
        inputCandidates: candidates.length,
        outputResults: reranked.length,
        kbArticlesInReranked: rerankedKb,
        rerankMs,
      });
      const rerankInfo = rerankResult.error ? ` [${rerankResult.error}]` : "";
      stream?.emit({
        type: "data-tool-progress",
        data: {
          toolName: "Knowledge (Hybrid)",
          content: `Reranked (${rerankMs}ms): ${reranked.length} results (${rerankedKb} KB)${rerankInfo}`,
        },
      });

      // Phase 4: LLM synthesis
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Knowledge (Hybrid)", content: "Composing answer..." },
      });

      // Build guidelines from the first workspace skill.
      // The skill's reference files (voice.md, platform.md, examples.md, etc.)
      // contain the actual guidelines — the SKILL.md body is just a routing table.
      const skill = skills?.[0];
      let guidelines: string | undefined;
      if (skill?.referenceFiles && Object.keys(skill.referenceFiles).length > 0) {
        // Concatenate all reference files into a single guidelines string
        guidelines = Object.entries(skill.referenceFiles)
          .filter(([path]) => path.endsWith(".md") && path !== "SKILL.md")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, content]) => content)
          .join("\n\n");
      } else if (skill?.instructions) {
        // Fallback: use SKILL.md body directly (for inline skills)
        guidelines = skill.instructions;
      }
      const systemPrompt = buildHybridPrompt(reranked, bm25Count, vecCount, guidelines);
      const llmStart = performance.now();

      const result = await generateText({
        model: traceModel(registry.languageModel("anthropic:claude-sonnet-4-6")),
        messages: [
          {
            role: "system",
            content: systemPrompt,
            providerOptions: getDefaultProviderOpts("anthropic"),
          },
          { role: "user", content: synthesisQuery },
        ],
        temperature: 0,
        maxRetries: 2,
        abortSignal,
      });

      const llmMs = Math.round(performance.now() - llmStart);
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Knowledge (Hybrid)", content: `LLM synthesis (${llmMs}ms)` },
      });

      const responseText = result.text || "No answer generated.";

      // Build structured sources from reranked results
      const sources: KnowledgeSource[] = reranked.map((r) => ({
        sectionTitle: r.title,
        chapter: r.sourceType,
        lineStart: r.id,
        lineEnd: r.id,
        sourceFile: r.url ?? "",
      }));

      const totalMs = Math.round(performance.now() - startTime);
      logger.info("Hybrid RAG complete", {
        totalMs,
        searchMs,
        rerankMs,
        llmMs: totalMs - searchMs - rerankMs,
        sourcesCount: sources.length,
      });

      return ok({ response: responseText, sources });
    } catch (error) {
      logger.error("Hybrid RAG agent failed", { error });
      return err(stringifyError(error));
    } finally {
      db.close();
    }
  },
});
