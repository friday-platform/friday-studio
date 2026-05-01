import { describe, expect, test } from "vitest";
import { blobToEmbedding, embeddingToBlob } from "./embed.ts";

describe("embeddingToBlob / blobToEmbedding", () => {
  test("round-trips a 768-dim embedding", () => {
    const embedding = Array.from({ length: 768 }, (_, i) => Math.sin(i) * 0.5);
    const blob = embeddingToBlob(embedding);
    const restored = blobToEmbedding(blob);

    expect(restored).toBeInstanceOf(Float32Array);
    expect(restored.length).toBe(768);
    for (let i = 0; i < embedding.length; i++) {
      expect(restored[i]).toBeCloseTo(embedding[i] ?? 0, 5);
    }
  });

  test("round-trips an empty embedding", () => {
    const blob = embeddingToBlob([]);
    const restored = blobToEmbedding(blob);
    expect(restored).toBeInstanceOf(Float32Array);
    expect(restored.length).toBe(0);
  });

  test("round-trips a single-element embedding", () => {
    const blob = embeddingToBlob([0.42]);
    const restored = blobToEmbedding(blob);
    expect(restored.length).toBe(1);
    expect(restored[0]).toBeCloseTo(0.42, 5);
  });

  test("handles zero values", () => {
    const embedding = [0, 0, 0];
    const blob = embeddingToBlob(embedding);
    const restored = blobToEmbedding(blob);
    expect(restored.length).toBe(3);
    expect(Array.from(restored)).toEqual([0, 0, 0]);
  });

  test("handles negative values", () => {
    const embedding = [-1.5, -0.001, 1.5];
    const blob = embeddingToBlob(embedding);
    const restored = blobToEmbedding(blob);
    expect(restored.length).toBe(3);
    for (let i = 0; i < embedding.length; i++) {
      expect(restored[i]).toBeCloseTo(embedding[i] ?? 0, 5);
    }
  });

  test("Float32Array is independent of original buffer", () => {
    const original = new Uint8Array([0, 0, 128, 63]); // 1.0 in little-endian float32
    const copy = blobToEmbedding(original);
    original[0] = 255; // corrupt original
    expect(copy[0]).toBeCloseTo(1.0, 5); // copy unaffected
  });

  test("blob size is 4 bytes per float", () => {
    const embedding = Array.from({ length: 768 }, () => 0);
    const blob = embeddingToBlob(embedding);
    expect(blob.byteLength).toBe(768 * 4);
  });
});
