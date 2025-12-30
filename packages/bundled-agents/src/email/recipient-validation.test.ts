import { assertEquals, assertThrows } from "@std/assert";
import { extractDomain, isPublicEmailDomain } from "./public-domains.ts";
import { validateRecipient } from "./recipient-validation.ts";

// =============================================================================
// extractDomain tests
// =============================================================================

Deno.test("extractDomain - extracts domain from valid email", () => {
  assertEquals(extractDomain("user@gmail.com"), "gmail.com");
  assertEquals(extractDomain("user@GMAIL.COM"), "gmail.com");
  assertEquals(extractDomain("user@tempest.team"), "tempest.team");
});

Deno.test("extractDomain - handles email with multiple @ symbols", () => {
  // Uses lastIndexOf, so this should work
  assertEquals(extractDomain("user@weird@gmail.com"), "gmail.com");
});

Deno.test("extractDomain - throws on invalid email without @", () => {
  assertThrows(() => extractDomain("invalid-email"), Error, "Invalid email address");
});

// =============================================================================
// isPublicEmailDomain tests
// =============================================================================

Deno.test("isPublicEmailDomain - identifies major providers", () => {
  // Note: isPublicEmailDomain expects lowercase input (use extractDomain to normalize)
  assertEquals(isPublicEmailDomain("gmail.com"), true);
  assertEquals(isPublicEmailDomain("yahoo.com"), true);
  assertEquals(isPublicEmailDomain("hotmail.com"), true);
  assertEquals(isPublicEmailDomain("outlook.com"), true);
  assertEquals(isPublicEmailDomain("icloud.com"), true);
  assertEquals(isPublicEmailDomain("protonmail.com"), true);
});

Deno.test("isPublicEmailDomain - identifies disposable email providers", () => {
  assertEquals(isPublicEmailDomain("mailinator.com"), true);
  assertEquals(isPublicEmailDomain("guerrillamail.com"), true);
  assertEquals(isPublicEmailDomain("10minutemail.com"), true);
  assertEquals(isPublicEmailDomain("temp-mail.org"), true);
});

Deno.test("isPublicEmailDomain - rejects company domains", () => {
  assertEquals(isPublicEmailDomain("tempest.team"), false);
  assertEquals(isPublicEmailDomain("acme.com"), false);
  assertEquals(isPublicEmailDomain("company.io"), false);
  assertEquals(isPublicEmailDomain("startup.co"), false);
});

// =============================================================================
// validateRecipient tests - Public domain users
// =============================================================================

Deno.test("validateRecipient - public domain user sends to self (allowed)", () => {
  const result = validateRecipient("user@gmail.com", "user@gmail.com");
  assertEquals(result.to, "user@gmail.com");
  assertEquals(result.overridden, false);
});

Deno.test("validateRecipient - public domain user sends to self with different case (allowed)", () => {
  const result = validateRecipient("User@Gmail.COM", "user@gmail.com");
  assertEquals(result.to, "user@gmail.com");
  assertEquals(result.overridden, false);
});

Deno.test("validateRecipient - public domain user sends to external (overridden)", () => {
  const result = validateRecipient("user@gmail.com", "other@company.com");
  assertEquals(result.to, "user@gmail.com");
  assertEquals(result.overridden, true);
});

Deno.test("validateRecipient - public domain user sends to different public domain (overridden)", () => {
  const result = validateRecipient("user@gmail.com", "other@yahoo.com");
  assertEquals(result.to, "user@gmail.com");
  assertEquals(result.overridden, true);
});

// =============================================================================
// validateRecipient tests - Company domain users
// =============================================================================

Deno.test("validateRecipient - company domain user sends to self (allowed)", () => {
  const result = validateRecipient("luke@tempest.team", "luke@tempest.team");
  assertEquals(result.to, "luke@tempest.team");
  assertEquals(result.overridden, false);
});

Deno.test("validateRecipient - company domain user sends to same domain colleague (allowed)", () => {
  const result = validateRecipient("luke@tempest.team", "colleague@tempest.team");
  assertEquals(result.to, "colleague@tempest.team");
  assertEquals(result.overridden, false);
});

Deno.test("validateRecipient - company domain user sends to same domain with different case (allowed)", () => {
  const result = validateRecipient("Luke@Tempest.Team", "Colleague@TEMPEST.TEAM");
  assertEquals(result.to, "colleague@tempest.team");
  assertEquals(result.overridden, false);
});

Deno.test("validateRecipient - company domain user sends to external company (overridden)", () => {
  const result = validateRecipient("luke@tempest.team", "someone@other-company.com");
  assertEquals(result.to, "luke@tempest.team");
  assertEquals(result.overridden, true);
});

Deno.test("validateRecipient - company domain user sends to public domain (overridden)", () => {
  const result = validateRecipient("luke@tempest.team", "personal@gmail.com");
  assertEquals(result.to, "luke@tempest.team");
  assertEquals(result.overridden, true);
});

// =============================================================================
// validateRecipient tests - Edge cases
// =============================================================================

Deno.test("validateRecipient - normalizes output to lowercase", () => {
  const result = validateRecipient("USER@TEMPEST.TEAM", "COLLEAGUE@TEMPEST.TEAM");
  assertEquals(result.to, "colleague@tempest.team");
});

Deno.test("validateRecipient - handles subdomains as different domains", () => {
  const result = validateRecipient("user@mail.company.com", "other@company.com");
  assertEquals(result.to, "user@mail.company.com");
  assertEquals(result.overridden, true);
});
