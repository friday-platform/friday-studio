/**
 * Unit tests for OIDC UserInfo schema and helpers
 */

import { describe, expect, it } from "vitest";
import { extractIdentifier, OidcUserInfoSchema } from "./userinfo.ts";

describe("OidcUserInfoSchema", () => {
  it("parses valid response with email", () => {
    const input = {
      sub: "user-123",
      email: "user@example.com",
      email_verified: true,
      name: "Test User",
    };

    const result = OidcUserInfoSchema.parse(input);

    expect(result.sub).toEqual("user-123");
    expect(result.email).toEqual("user@example.com");
    expect(result.email_verified).toEqual(true);
    expect(result.name).toEqual("Test User");
  });

  it("parses valid response with only sub", () => {
    const input = { sub: "user-456" };

    const result = OidcUserInfoSchema.parse(input);

    expect(result.sub).toEqual("user-456");
    expect(result.email).toEqual(undefined);
  });

  it("fails when sub is missing", () => {
    const input = { email: "user@example.com" };

    const result = OidcUserInfoSchema.safeParse(input);

    expect(result.success).toEqual(false);
  });

  it("fails when email is invalid", () => {
    const input = { sub: "user-123", email: "not-an-email" };

    const result = OidcUserInfoSchema.safeParse(input);

    expect(result.success).toEqual(false);
  });

  it("passthrough preserves extra claims", () => {
    const input = {
      sub: "user-123",
      email: "user@example.com",
      custom_claim: "custom_value",
      another_field: 42,
    };

    const result = OidcUserInfoSchema.parse(input);

    expect(result.sub).toEqual("user-123");
    expect(result.email).toEqual("user@example.com");
    expect(result.custom_claim).toEqual("custom_value");
    expect(result.another_field).toEqual(42);
  });

  it("parses optional fields", () => {
    const input = {
      sub: "user-123",
      given_name: "John",
      family_name: "Doe",
      picture: "https://example.com/avatar.jpg",
      locale: "en-US",
    };

    const result = OidcUserInfoSchema.parse(input);

    expect(result.given_name).toEqual("John");
    expect(result.family_name).toEqual("Doe");
    expect(result.picture).toEqual("https://example.com/avatar.jpg");
    expect(result.locale).toEqual("en-US");
  });

  it("fails when picture is not a valid URL", () => {
    const input = { sub: "user-123", picture: "not-a-url" };

    const result = OidcUserInfoSchema.safeParse(input);

    expect(result.success).toEqual(false);
  });
});

describe("extractIdentifier", () => {
  it("returns email when available", () => {
    const userinfo = { sub: "user-123", email: "user@example.com" };

    const identifier = extractIdentifier(userinfo);

    expect(identifier).toEqual("user@example.com");
  });

  it("falls back to sub when email is not present", () => {
    const userinfo = { sub: "user-456" };

    const identifier = extractIdentifier(userinfo);

    expect(identifier).toEqual("user-456");
  });

  it("prefers email over sub when both are present", () => {
    const userinfo = { sub: "user-123", email: "user@example.com" };

    const identifier = extractIdentifier(userinfo);

    expect(identifier).toEqual("user@example.com");
  });
});
