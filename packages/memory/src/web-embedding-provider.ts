/**
 * Web Embedding Provider for MECMF
 *
 * Integrates with the existing Atlas /embeddings/ infrastructure to provide
 * production-ready sentence-transformers/all-MiniLM-L6-v2 embeddings via ONNX Runtime.
 *
 * Based on MECMF Section 3.5.1 specifications and existing /embeddings/main.ts implementation.
 */

import ort from "npm:onnxruntime-node";
import { crypto } from "jsr:@std/crypto";
import { ensureDir } from "@std/fs";
import { getMECMFCacheDir } from "../../../src/utils/paths.ts";
import { AtlasEmbeddingConfig, MECMFEmbeddingProvider } from "./mecmf-interfaces.ts";

export interface TokenizerConfig {
  vocab: Record<string, number>;
  special_tokens: Record<string, number>;
  do_lower_case: boolean;
  max_len?: number;
  cls_token?: string;
  sep_token?: string;
  pad_token?: string;
  unk_token?: string;
  mask_token?: string;
  cls_token_id?: number;
  sep_token_id?: number;
  pad_token_id?: number;
  unk_token_id?: number;
  mask_token_id?: number;
}

export interface EmbeddingResult {
  modelName: string;
  time: number;
  embedding: number[];
}

export class BERTTokenizer {
  private vocab: Record<string, number> = {};
  private idToToken: Record<number, string> = {};
  private _specialTokens: Record<string, number> = {};
  private doLowerCase: boolean = true;
  private maxLength: number = 512;
  private clsToken: string = "[CLS]";
  private sepToken: string = "[SEP]";
  private _padToken: string = "[PAD]";
  private unkToken: string = "[UNK]";
  private _maskToken: string = "[MASK]";
  private _clsTokenId: number = 101;
  private _sepTokenId: number = 102;
  private padTokenId: number = 0;
  private unkTokenId: number = 100;
  private _maskTokenId: number = 103;

  constructor(config: TokenizerConfig) {
    this.vocab = config.vocab;
    this._specialTokens = config.special_tokens;
    this.doLowerCase = config.do_lower_case;
    this.maxLength = config.max_len || 512;

    // Set token strings and IDs from config
    this.clsToken = config.cls_token || "[CLS]";
    this.sepToken = config.sep_token || "[SEP]";
    this._padToken = config.pad_token || "[PAD]";
    this.unkToken = config.unk_token || "[UNK]";
    this._maskToken = config.mask_token || "[MASK]";

    this._clsTokenId = config.cls_token_id ?? 101;
    this._sepTokenId = config.sep_token_id ?? 102;
    this.padTokenId = config.pad_token_id ?? 0;
    this.unkTokenId = config.unk_token_id ?? 100;
    this._maskTokenId = config.mask_token_id ?? 103;

    // Create reverse mapping
    for (const [token, id] of Object.entries(this.vocab)) {
      this.idToToken[id] = token;
    }
  }

  private basicTokenize(text: string): string[] {
    // Basic whitespace tokenization with lowercasing
    text = text.trim();
    if (this.doLowerCase) {
      text = text.toLowerCase();
    }
    return text.split(/\s+/).filter((token) => token.length > 0);
  }

  private wordpieceTokenize(word: string): string[] {
    if (word.length > 200) {
      return [this.unkToken];
    }

    const tokens: string[] = [];
    let start = 0;

    while (start < word.length) {
      let end = word.length;
      let curSubStr = "";

      while (start < end) {
        let subStr = word.substring(start, end);
        if (start > 0) {
          subStr = "##" + subStr;
        }

        if (this.vocab[subStr]) {
          curSubStr = subStr;
          break;
        }
        end -= 1;
      }

      if (curSubStr === "") {
        tokens.push(this.unkToken);
        break;
      }

      tokens.push(curSubStr);
      start = end;
    }

    return tokens;
  }

  public tokenize(text: string): number[] {
    const tokens: string[] = [this.clsToken];

    const words = this.basicTokenize(text);
    for (const word of words) {
      const wordTokens = this.wordpieceTokenize(word);
      tokens.push(...wordTokens);
    }

    tokens.push(this.sepToken);

    // Convert to IDs
    const tokenIds = tokens.map((token) => {
      return this.vocab[token] ?? this.unkTokenId;
    });

    // Pad or truncate to max length
    while (tokenIds.length < this.maxLength) {
      tokenIds.push(this.padTokenId);
    }

    return tokenIds.slice(0, this.maxLength);
  }

  public getPadTokenId(): number {
    return this.padTokenId;
  }
}

export class WebEmbeddingProvider implements MECMFEmbeddingProvider {
  private session: ort.InferenceSession | null = null;
  private tokenizer: BERTTokenizer | null = null;
  private config: AtlasEmbeddingConfig;
  private ready: boolean = false;
  private initializationPromise: Promise<void> | null = null;

  // Use production model URLs from existing /embeddings/ implementation
  private readonly MODEL_URL =
    "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx";
  private readonly TOKENIZER_URL =
    "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json";
  private readonly MODEL_NAME = "all-MiniLM-L6-v2";

  constructor(config?: Partial<AtlasEmbeddingConfig>) {
    this.config = {
      model: "sentence-transformers/all-MiniLM-L6-v2",
      backend: "onnxruntime-node",
      batchSize: 10,
      maxSequenceLength: 512,
      cacheDirectory: getMECMFCacheDir(),
      tokenizerConfig: {
        doLowerCase: true,
        maxLength: 512,
        padTokenId: 0,
        unkTokenId: 100,
        clsTokenId: 101,
        sepTokenId: 102,
      },
      ...config,
    };
  }

  async generateEmbedding(text: string): Promise<number[]> {
    await this.ensureInitialized();

    if (!this.session || !this.tokenizer) {
      throw new Error("WebEmbeddingProvider not properly initialized");
    }

    const result = await this.calculateEmbedding(text, this.session, this.tokenizer);
    return result.embedding;
  }

  async generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];

    // Process in batches for optimal performance
    for (let i = 0; i < texts.length; i += this.config.batchSize) {
      const batch = texts.slice(i, i + this.config.batchSize);
      const batchPromises = batch.map((text) => this.generateEmbedding(text));
      const batchResults = await Promise.all(batchPromises);
      embeddings.push(...batchResults);
    }

    return embeddings;
  }

  getDimension(): number {
    return 384; // all-MiniLM-L6-v2 produces 384-dimensional embeddings
  }

  getModelInfo(): string {
    return `${this.MODEL_NAME} (ONNX Runtime, 384 dimensions)`;
  }

  isReady(): boolean {
    return this.ready;
  }

  async warmup(): Promise<void> {
    await this.ensureInitialized();

    // Perform a warmup embedding to load models into memory
    const warmupText = "This is a warmup text to initialize the embedding model.";
    await this.generateEmbedding(warmupText);
  }

  async dispose(): Promise<void> {
    if (this.session) {
      try {
        await this.session.release();
      } catch (error) {
        // Silently handle cleanup errors
      }
      this.session = null;
    }

    this.tokenizer = null;
    this.ready = false;
    this.initializationPromise = null;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.ready) {
      return;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.initialize();
    return this.initializationPromise;
  }

  private async initialize(): Promise<void> {
    try {
      // Load tokenizer and model
      this.tokenizer = await this.loadTokenizer(this.TOKENIZER_URL);
      this.session = await this.loadONNXModel(this.MODEL_URL);

      this.ready = true;
    } catch (error) {
      this.ready = false;
      this.initializationPromise = null;
      throw new Error(`Failed to initialize WebEmbeddingProvider: ${error.message}`);
    }
  }

  private async getCachedFilePath(url: string, extension: string = ".onnx"): Promise<string> {
    // Create cache directory if it doesn't exist
    const cacheDir = this.config.cacheDirectory;
    await ensureDir(cacheDir);

    // Create filename from URL hash
    const urlHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)),
      ),
    ).map((b) => b.toString(16).padStart(2, "0")).join("");

    return `${cacheDir}/${urlHash.slice(0, 16)}${extension}`;
  }

  private async downloadFile(
    url: string,
    filepath: string,
    description: string = "file",
  ): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Error downloading ${description}: ${response.statusText}`);
    }

    // Write to file
    const file = await Deno.open(filepath, { write: true, create: true });
    await response.body?.pipeTo(file.writable);
  }

  private async loadTokenizer(url: string): Promise<BERTTokenizer> {
    const cachedPath = await this.getCachedFilePath(url, ".json");

    // Check if cached file exists
    try {
      await Deno.stat(cachedPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Download and cache the tokenizer
        await this.downloadFile(url, cachedPath, "tokenizer");
      } else {
        throw error;
      }
    }

    // Load tokenizer config
    const tokenizerData = await Deno.readTextFile(cachedPath);
    const tokenizerJson = JSON.parse(tokenizerData);

    // Extract vocabulary and configuration (using existing logic from /embeddings/main.ts)
    const vocab: Record<string, number> = {};
    const specialTokens: Record<string, number> = {};

    if (tokenizerJson.model && tokenizerJson.model.vocab) {
      Object.assign(vocab, tokenizerJson.model.vocab);
    }

    // Extract special tokens
    let padToken = "[PAD]", unkToken = "[UNK]", clsToken = "[CLS]";
    let sepToken = "[SEP]", maskToken = "[MASK]";
    let padTokenId = 0, unkTokenId = 100, clsTokenId = 101;
    let sepTokenId = 102, maskTokenId = 103;

    // Process added_tokens if available
    if (tokenizerJson.added_tokens) {
      for (const token of tokenizerJson.added_tokens) {
        if (token.content) {
          specialTokens[token.content] = token.id;
          if (token.content === "[PAD]") {
            padToken = token.content;
            padTokenId = token.id;
          } else if (token.content === "[UNK]") {
            unkToken = token.content;
            unkTokenId = token.id;
          } else if (token.content === "[CLS]") {
            clsToken = token.content;
            clsTokenId = token.id;
          } else if (token.content === "[SEP]") {
            sepToken = token.content;
            sepTokenId = token.id;
          } else if (token.content === "[MASK]") {
            maskToken = token.content;
            maskTokenId = token.id;
          }
        }
      }
    }

    // Fallback to vocab lookup
    if (vocab[padToken]) padTokenId = vocab[padToken];
    if (vocab[unkToken]) unkTokenId = vocab[unkToken];
    if (vocab[clsToken]) clsTokenId = vocab[clsToken];
    if (vocab[sepToken]) sepTokenId = vocab[sepToken];
    if (vocab[maskToken]) maskTokenId = vocab[maskToken];

    // Ensure special tokens are in map
    specialTokens[padToken] = padTokenId;
    specialTokens[unkToken] = unkTokenId;
    specialTokens[clsToken] = clsTokenId;
    specialTokens[sepToken] = sepTokenId;
    specialTokens[maskToken] = maskTokenId;

    // Extract normalization and length settings
    let doLowerCase = true;
    if (tokenizerJson.normalizer && tokenizerJson.normalizer.lowercase !== undefined) {
      doLowerCase = tokenizerJson.normalizer.lowercase;
    }

    let maxLen = this.config.maxSequenceLength;
    if (tokenizerJson.truncation && tokenizerJson.truncation.max_length) {
      maxLen = tokenizerJson.truncation.max_length;
    }

    const tokenizerConfig: TokenizerConfig = {
      vocab,
      special_tokens: specialTokens,
      do_lower_case: doLowerCase,
      max_len: maxLen,
      cls_token: clsToken,
      sep_token: sepToken,
      pad_token: padToken,
      unk_token: unkToken,
      mask_token: maskToken,
      cls_token_id: clsTokenId,
      sep_token_id: sepTokenId,
      pad_token_id: padTokenId,
      unk_token_id: unkTokenId,
      mask_token_id: maskTokenId,
    };

    return new BERTTokenizer(tokenizerConfig);
  }

  private async loadONNXModel(url: string): Promise<ort.InferenceSession> {
    const cachedPath = await this.getCachedFilePath(url, ".onnx");

    // Check if cached file exists
    try {
      await Deno.stat(cachedPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Download and cache the model
        await this.downloadFile(url, cachedPath, "model");
      } else {
        throw error;
      }
    }

    // Load from cached file
    const session = await ort.InferenceSession.create(cachedPath);
    return session;
  }

  private createAttentionMask(tokenIds: number[], padTokenId: number = 0): number[] {
    return tokenIds.map((id) => id === padTokenId ? 0 : 1);
  }

  private async calculateEmbedding(
    text: string,
    session: ort.InferenceSession,
    tokenizer: BERTTokenizer,
  ): Promise<EmbeddingResult> {
    const startTime = performance.now();

    try {
      // Tokenize the input text using BERT tokenizer
      const tokenIds = tokenizer.tokenize(text);
      const attentionMask = this.createAttentionMask(tokenIds, tokenizer.getPadTokenId());

      // Prepare tensors
      const maxLength = tokenIds.length;
      const inputIdsArray = new BigInt64Array(tokenIds.map((id) => BigInt(id)));
      const attentionMaskArray = new BigInt64Array(attentionMask.map((mask) => BigInt(mask)));

      const inputIdsTensor = new ort.Tensor("int64", inputIdsArray, [1, maxLength]);
      const attentionMaskTensor = new ort.Tensor("int64", attentionMaskArray, [1, maxLength]);

      const inputs: Record<string, ort.Tensor> = {};

      // Set up inputs based on model requirements
      if (session.inputNames.includes("input_ids")) {
        inputs["input_ids"] = inputIdsTensor;
      } else if (session.inputNames.length > 0) {
        inputs[session.inputNames[0]] = inputIdsTensor;
      }

      if (session.inputNames.includes("attention_mask")) {
        inputs["attention_mask"] = attentionMaskTensor;
      } else if (session.inputNames.length > 1) {
        inputs[session.inputNames[1]] = attentionMaskTensor;
      }

      // Add token_type_ids if required
      if (session.inputNames.includes("token_type_ids")) {
        const tokenTypeIds = new BigInt64Array(maxLength).fill(BigInt(0));
        const tokenTypeIdsTensor = new ort.Tensor("int64", tokenTypeIds, [1, maxLength]);
        inputs["token_type_ids"] = tokenTypeIdsTensor;
      }

      const results = await session.run(inputs);
      const outputKey = Object.keys(results)[0];
      const outputTensor = results[outputKey];

      const endTime = performance.now();
      const time = Math.round(endTime - startTime);

      // Perform mean pooling to get sentence embedding
      const data = outputTensor.data as Float32Array;
      const [_batchSize, seqLength, hiddenSize] = outputTensor.dims as number[];

      const embedding = new Array(hiddenSize).fill(0);
      let validTokens = 0;

      for (let i = 0; i < seqLength; i++) {
        if (attentionMask[i] === 1) {
          for (let j = 0; j < hiddenSize; j++) {
            embedding[j] += data[i * hiddenSize + j];
          }
          validTokens++;
        }
      }

      // Average the embeddings
      for (let j = 0; j < hiddenSize; j++) {
        embedding[j] /= validTokens;
      }

      return {
        modelName: this.MODEL_NAME,
        time,
        embedding,
      };
    } catch (error) {
      throw error;
    }
  }
}

// Factory function for easy instantiation
export function createWebEmbeddingProvider(
  config?: Partial<AtlasEmbeddingConfig>,
): WebEmbeddingProvider {
  return new WebEmbeddingProvider(config);
}
