import { describe, expect, it } from "vitest";
import { extractDomain, isPublicEmailDomain } from "./public-domains.ts";
import { validateRecipient } from "./recipient-validation.ts";

// =============================================================================
// extractDomain tests
// =============================================================================

describe("extractDomain", () => {
  it("extracts domain from valid email", () => {
    expect(extractDomain("user@gmail.com")).toEqual("gmail.com");
    expect(extractDomain("user@GMAIL.COM")).toEqual("gmail.com");
    expect(extractDomain("user@example.com")).toEqual("example.com");
  });

  it("handles email with multiple @ symbols", () => {
    // Uses lastIndexOf, so this should work
    expect(extractDomain("user@weird@gmail.com")).toEqual("gmail.com");
  });

  it("throws on invalid email without @", () => {
    expect(() => extractDomain("invalid-email")).toThrow("Invalid email address");
  });
});

// =============================================================================
// isPublicEmailDomain tests
// =============================================================================

describe("isPublicEmailDomain", () => {
  it("identifies major providers", () => {
    // Note: isPublicEmailDomain expects lowercase input (use extractDomain to normalize)
    expect(isPublicEmailDomain("gmail.com")).toEqual(true);
    expect(isPublicEmailDomain("yahoo.com")).toEqual(true);
    expect(isPublicEmailDomain("hotmail.com")).toEqual(true);
    expect(isPublicEmailDomain("outlook.com")).toEqual(true);
    expect(isPublicEmailDomain("icloud.com")).toEqual(true);
    expect(isPublicEmailDomain("protonmail.com")).toEqual(true);
  });

  it("identifies disposable email providers", () => {
    expect(isPublicEmailDomain("mailinator.com")).toEqual(true);
    expect(isPublicEmailDomain("guerrillamail.com")).toEqual(true);
    expect(isPublicEmailDomain("10minutemail.com")).toEqual(true);
    expect(isPublicEmailDomain("temp-mail.org")).toEqual(true);
  });

  it("rejects company domains", () => {
    expect(isPublicEmailDomain("example.com")).toEqual(false);
    expect(isPublicEmailDomain("acme.com")).toEqual(false);
    expect(isPublicEmailDomain("company.io")).toEqual(false);
    expect(isPublicEmailDomain("startup.co")).toEqual(false);
  });
});

// =============================================================================
// validateRecipient tests - Public domain users
// =============================================================================

describe("validateRecipient - Public domain users", () => {
  it("public domain user sends to self (allowed)", () => {
    const result = validateRecipient("user@gmail.com", "user@gmail.com");
    expect(result.to).toEqual("user@gmail.com");
    expect(result.overridden).toEqual(false);
  });

  it("public domain user sends to self with different case (allowed)", () => {
    const result = validateRecipient("User@Gmail.COM", "user@gmail.com");
    expect(result.to).toEqual("user@gmail.com");
    expect(result.overridden).toEqual(false);
  });

  it("public domain user sends to external (overridden)", () => {
    const result = validateRecipient("user@gmail.com", "other@company.com");
    expect(result.to).toEqual("user@gmail.com");
    expect(result.overridden).toEqual(true);
  });

  it("public domain user sends to different public domain (overridden)", () => {
    const result = validateRecipient("user@gmail.com", "other@yahoo.com");
    expect(result.to).toEqual("user@gmail.com");
    expect(result.overridden).toEqual(true);
  });
});

// =============================================================================
// validateRecipient tests - Company domain users
// =============================================================================

describe("validateRecipient - Company domain users", () => {
  it("company domain user sends to self (allowed)", () => {
    const result = validateRecipient("luke@example.com", "luke@example.com");
    expect(result.to).toEqual("luke@example.com");
    expect(result.overridden).toEqual(false);
  });

  it("company domain user sends to same domain colleague (allowed)", () => {
    const result = validateRecipient("luke@example.com", "colleague@example.com");
    expect(result.to).toEqual("colleague@example.com");
    expect(result.overridden).toEqual(false);
  });

  it("company domain user sends to same domain with different case (allowed)", () => {
    const result = validateRecipient("Luke@Example.Com", "Colleague@EXAMPLE.COM");
    expect(result.to).toEqual("colleague@example.com");
    expect(result.overridden).toEqual(false);
  });

  it("company domain user sends to external company (overridden)", () => {
    const result = validateRecipient("luke@example.com", "someone@other-company.com");
    expect(result.to).toEqual("luke@example.com");
    expect(result.overridden).toEqual(true);
  });

  it("company domain user sends to public domain (overridden)", () => {
    const result = validateRecipient("luke@example.com", "personal@gmail.com");
    expect(result.to).toEqual("luke@example.com");
    expect(result.overridden).toEqual(true);
  });
});

// =============================================================================
// validateRecipient tests - Edge cases
// =============================================================================

describe("validateRecipient - Edge cases", () => {
  it("normalizes output to lowercase", () => {
    const result = validateRecipient("USER@EXAMPLE.COM", "COLLEAGUE@EXAMPLE.COM");
    expect(result.to).toEqual("colleague@example.com");
  });

  it("handles subdomains as different domains", () => {
    const result = validateRecipient("user@mail.company.com", "other@company.com");
    expect(result.to).toEqual("user@mail.company.com");
    expect(result.overridden).toEqual(true);
  });
});
