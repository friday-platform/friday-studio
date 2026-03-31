import { describe, expect, test } from "vitest";
import {
  ACCEPT_STRING,
  ACCEPTED_TYPES,
  MAX_FILE_SIZE,
  validateImageFile,
} from "./image-picker-validation.ts";

function createTestFile(name: string, size: number, type: string): File {
  return new File([new ArrayBuffer(size)], name, { type });
}

describe("validateImageFile", () => {
  const validCases = [
    { name: "PNG", type: "image/png" },
    { name: "JPEG", type: "image/jpeg" },
    { name: "GIF", type: "image/gif" },
    { name: "WebP", type: "image/webp" },
  ] as const;

  test.each(validCases)("accepts valid $name file", ({ type }) => {
    const file = createTestFile("photo.img", 1024, type);
    expect(validateImageFile(file)).toBeNull();
  });

  const invalidTypeCases = [
    { name: "PDF", type: "application/pdf" },
    { name: "SVG", type: "image/svg+xml" },
    { name: "text", type: "text/plain" },
    { name: "empty type", type: "" },
  ] as const;

  test.each(invalidTypeCases)("rejects $name file type", ({ type }) => {
    const file = createTestFile("bad.file", 1024, type);
    expect(validateImageFile(file)).toBe("File must be an image (PNG, JPEG, GIF, or WebP)");
  });

  test("rejects file exceeding 5MB", () => {
    const file = createTestFile("huge.png", MAX_FILE_SIZE + 1, "image/png");
    expect(validateImageFile(file)).toBe("File must be smaller than 5MB");
  });

  test("accepts file at exactly 5MB", () => {
    const file = createTestFile("exact.png", MAX_FILE_SIZE, "image/png");
    expect(validateImageFile(file)).toBeNull();
  });

  test("checks type before size (invalid type + oversized returns type error)", () => {
    const file = createTestFile("bad.pdf", MAX_FILE_SIZE + 1, "application/pdf");
    expect(validateImageFile(file)).toBe("File must be an image (PNG, JPEG, GIF, or WebP)");
  });
});

describe("constants", () => {
  test("MAX_FILE_SIZE is 5MB", () => {
    expect(MAX_FILE_SIZE).toBe(5 * 1024 * 1024);
  });

  test("ACCEPTED_TYPES contains expected image formats", () => {
    expect(ACCEPTED_TYPES).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  });

  test("ACCEPT_STRING is comma-joined types for file input", () => {
    expect(ACCEPT_STRING).toBe("image/png,image/jpeg,image/gif,image/webp");
  });
});
