import { UserConfigurationError } from "@atlas/core";
import { describe, expect, it } from "vitest";
import { classifySessionError } from "./workspace-runtime.ts";

describe("classifySessionError", () => {
  it("UserConfigurationError.missingConfiguration returns skipped", () => {
    const error = UserConfigurationError.missingConfiguration(
      "test-agent",
      "test-workspace",
      ["google-calendar"],
      [],
    );
    expect(classifySessionError(error)).toEqual("skipped");
  });

  it("UserConfigurationError.credentialRefreshFailed returns skipped", () => {
    const error = UserConfigurationError.credentialRefreshFailed("test-agent", "github");
    expect(classifySessionError(error)).toEqual("skipped");
  });

  it("generic Error returns failed", () => {
    const error = new Error("Something went wrong");
    expect(classifySessionError(error)).toEqual("failed");
  });

  it("TypeError returns failed", () => {
    const error = new TypeError("Cannot read property of undefined");
    expect(classifySessionError(error)).toEqual("failed");
  });

  it("string error returns failed", () => {
    expect(classifySessionError("string error")).toEqual("failed");
  });

  it("null returns failed", () => {
    expect(classifySessionError(null)).toEqual("failed");
  });

  it("undefined returns failed", () => {
    expect(classifySessionError(undefined)).toEqual("failed");
  });
});
