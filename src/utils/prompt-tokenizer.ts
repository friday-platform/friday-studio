/**
 * Simple Prompt Tokenization Utilities
 *
 * Provides text processing for vector search queries without requiring LLM API calls.
 */

interface TokenizationOptions {
  /**
   * Remove common stop words
   */
  removeStopWords?: boolean;

  /**
   * Minimum word length to include
   */
  minWordLength?: number;

  /**
   * Maximum number of tokens to return
   */
  maxTokens?: number;

  /**
   * Include technical terms that might appear as single characters
   */
  includeTechnicalTerms?: boolean;
}

export interface ProcessedPrompt {
  /**
   * Original text
   */
  original: string;

  /**
   * Cleaned and processed text for vector search
   */
  processed: string;

  /**
   * Individual tokens extracted
   */
  tokens: string[];

  /**
   * Key phrases identified
   */
  keyPhrases: string[];

  /**
   * Technical terms found
   */
  technicalTerms: string[];
}

// Common stop words to remove for better semantic search
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "that",
  "the",
  "to",
  "was",
  "will",
  "with",
  "i",
  "you",
  "we",
  "they",
  "this",
  "that",
  "these",
  "those",
  "can",
  "could",
  "should",
  "would",
  "may",
  "might",
  "must",
  "shall",
  "do",
  "does",
  "did",
  "have",
  "had",
  "but",
  "or",
  "if",
  "when",
  "where",
  "why",
  "how",
  "what",
  "who",
  "which",
  "whose",
  "am",
  "is",
  "are",
  "was",
  "were",
  "been",
  "being",
  "get",
  "got",
  "getting",
  "go",
  "goes",
  "going",
  "went",
  "gone",
  "make",
  "makes",
  "making",
  "made",
]);

// Technical terms that should be preserved even if short
const TECHNICAL_TERMS = new Set([
  "ai",
  "ml",
  "ui",
  "ux",
  "api",
  "cli",
  "cpu",
  "gpu",
  "ram",
  "ssd",
  "hdd",
  "os",
  "id",
  "db",
  "sql",
  "css",
  "js",
  "ts",
  "py",
  "go",
  "rs",
  "c",
  "c++",
  "aws",
  "gcp",
  "k8s",
  "ci",
  "cd",
  "qa",
  "pr",
  "mr",
  "git",
  "svn",
  "npm",
  "pip",
  "apt",
  "gem",
  "mvn",
  "ant",
  "tar",
  "zip",
  "pdf",
  "csv",
  "json",
  "xml",
  "yaml",
  "yml",
  "env",
  "cfg",
  "ini",
  "log",
  "tmp",
  "src",
  "lib",
  "bin",
  "opt",
  "var",
  "etc",
  "usr",
  "dev",
  "sys",
  "proc",
  "mnt",
  "home",
]);

/**
 * Tokenize a user prompt for vector search
 */
export function tokenizePrompt(text: string, options: TokenizationOptions = {}): ProcessedPrompt {
  const {
    removeStopWords = true,
    minWordLength = 2,
    maxTokens = 100,
    includeTechnicalTerms = true,
  } = options;

  // Normalize text
  const normalized = text
    .toLowerCase()
    .trim()
    // Replace multiple spaces with single space
    .replace(/\s+/g, " ")
    // Remove special characters but keep alphanumeric and some punctuation
    .replace(/[^\w\s\-./]/g, " ")
    // Clean up extra spaces
    .replace(/\s+/g, " ");

  // Extract words
  const words = normalized.split(/\s+/).filter((word) => word.length > 0);

  // Filter and process tokens
  const tokens: string[] = [];
  const technicalTerms: string[] = [];

  for (const word of words) {
    // Clean the word
    const cleanWord = word.replace(/[^\w]/g, "");

    if (cleanWord.length === 0) continue;

    // Check if it's a technical term
    if (includeTechnicalTerms && TECHNICAL_TERMS.has(cleanWord)) {
      tokens.push(cleanWord);
      technicalTerms.push(cleanWord);
      continue;
    }

    // Apply length filter
    if (cleanWord.length < minWordLength) continue;

    // Apply stop word filter
    if (removeStopWords && STOP_WORDS.has(cleanWord)) continue;

    tokens.push(cleanWord);
  }

  // Limit tokens if specified
  const finalTokens = maxTokens ? tokens.slice(0, maxTokens) : tokens;

  // Extract key phrases (2-3 word combinations)
  const keyPhrases = extractKeyPhrases(words, removeStopWords);

  // Reconstruct processed text
  const processed = finalTokens.join(" ");

  return { original: text, processed, tokens: finalTokens, keyPhrases, technicalTerms };
}

/**
 * Extract meaningful phrases from text
 */
function extractKeyPhrases(words: string[], removeStopWords: boolean): string[] {
  const phrases: string[] = [];

  // Extract 2-word phrases
  for (let i = 0; i < words.length - 1; i++) {
    const word1 = words[i]?.replace(/[^\w]/g, "") || "";
    const word2 = words[i + 1]?.replace(/[^\w]/g, "") || "";

    if (word1.length < 2 || word2.length < 2) continue;

    // Skip if both words are stop words
    if (removeStopWords && STOP_WORDS.has(word1) && STOP_WORDS.has(word2)) continue;

    phrases.push(`${word1} ${word2}`);
  }

  // Extract 3-word phrases for important concepts
  for (let i = 0; i < words.length - 2; i++) {
    const word1 = words[i]?.replace(/[^\w]/g, "") || "";
    const word2 = words[i + 1]?.replace(/[^\w]/g, "") || "";
    const word3 = words[i + 2]?.replace(/[^\w]/g, "") || "";

    if (word1.length < 2 || word2.length < 2 || word3.length < 2) continue;

    // Only include 3-word phrases if they contain technical terms or important words
    const hasImportantWord = [word1, word2, word3].some(
      (word) =>
        TECHNICAL_TERMS.has(word) ||
        ((!removeStopWords || !STOP_WORDS.has(word)) && word.length > 4),
    );

    if (hasImportantWord) {
      phrases.push(`${word1} ${word2} ${word3}`);
    }
  }

  // Remove duplicates and limit
  return [...new Set(phrases)].slice(0, 10);
}

/**
 * Extract search terms from various types of content
 */
export function extractSearchTerms(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (typeof content === "object" && content !== null) {
    // Extract meaningful text from objects
    const textFields = [
      "title",
      "description",
      "summary",
      "content",
      "text",
      "message",
      "statement",
    ];

    for (const field of textFields) {
      const value = content[field];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }

    // Fallback to JSON representation, cleaned up
    const jsonStr = JSON.stringify(content);
    return jsonStr
      .replace(/[{}[\]"]/g, " ")
      .replace(/[,:]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return String(content);
}
