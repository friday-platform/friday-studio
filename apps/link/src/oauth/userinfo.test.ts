/**
 * Unit tests for OIDC UserInfo schema and helpers
 */

import { assertEquals } from "@std/assert";
import { extractIdentifier, OidcUserInfoSchema } from "./userinfo.ts";

Deno.test("OidcUserInfoSchema", async (t) => {
  await t.step("parses valid response with email", () => {
    const input = {
      sub: "user-123",
      email: "user@example.com",
      email_verified: true,
      name: "Test User",
    };

    const result = OidcUserInfoSchema.parse(input);

    assertEquals(result.sub, "user-123");
    assertEquals(result.email, "user@example.com");
    assertEquals(result.email_verified, true);
    assertEquals(result.name, "Test User");
  });

  await t.step("parses valid response with only sub", () => {
    const input = { sub: "user-456" };

    const result = OidcUserInfoSchema.parse(input);

    assertEquals(result.sub, "user-456");
    assertEquals(result.email, undefined);
  });

  await t.step("fails when sub is missing", () => {
    const input = { email: "user@example.com" };

    const result = OidcUserInfoSchema.safeParse(input);

    assertEquals(result.success, false);
  });

  await t.step("fails when email is invalid", () => {
    const input = { sub: "user-123", email: "not-an-email" };

    const result = OidcUserInfoSchema.safeParse(input);

    assertEquals(result.success, false);
  });

  await t.step("passthrough preserves extra claims", () => {
    const input = {
      sub: "user-123",
      email: "user@example.com",
      custom_claim: "custom_value",
      another_field: 42,
    };

    const result = OidcUserInfoSchema.parse(input);

    assertEquals(result.sub, "user-123");
    assertEquals(result.email, "user@example.com");
    assertEquals(result.custom_claim, "custom_value");
    assertEquals(result.another_field, 42);
  });

  await t.step("parses optional fields", () => {
    const input = {
      sub: "user-123",
      given_name: "John",
      family_name: "Doe",
      picture: "https://example.com/avatar.jpg",
      locale: "en-US",
    };

    const result = OidcUserInfoSchema.parse(input);

    assertEquals(result.given_name, "John");
    assertEquals(result.family_name, "Doe");
    assertEquals(result.picture, "https://example.com/avatar.jpg");
    assertEquals(result.locale, "en-US");
  });

  await t.step("fails when picture is not a valid URL", () => {
    const input = { sub: "user-123", picture: "not-a-url" };

    const result = OidcUserInfoSchema.safeParse(input);

    assertEquals(result.success, false);
  });
});

Deno.test("extractIdentifier", async (t) => {
  await t.step("returns email when available", () => {
    const userinfo = { sub: "user-123", email: "user@example.com" };

    const identifier = extractIdentifier(userinfo);

    assertEquals(identifier, "user@example.com");
  });

  await t.step("falls back to sub when email is not present", () => {
    const userinfo = { sub: "user-456" };

    const identifier = extractIdentifier(userinfo);

    assertEquals(identifier, "user-456");
  });

  await t.step("prefers email over sub when both are present", () => {
    const userinfo = { sub: "user-123", email: "user@example.com" };

    const identifier = extractIdentifier(userinfo);

    assertEquals(identifier, "user@example.com");
  });
});
