import { UserConfigurationError } from "@atlas/core";
import { assertEquals } from "@std/assert";
import { classifySessionError } from "./workspace-runtime.ts";

Deno.test("classifySessionError - UserConfigurationError.missingConfiguration returns skipped", () => {
  const error = UserConfigurationError.missingConfiguration(
    "test-agent",
    "test-workspace",
    ["google-calendar"],
    [],
  );
  assertEquals(classifySessionError(error), "skipped");
});

Deno.test("classifySessionError - UserConfigurationError.credentialRefreshFailed returns skipped", () => {
  const error = UserConfigurationError.credentialRefreshFailed("test-agent", "github");
  assertEquals(classifySessionError(error), "skipped");
});

Deno.test("classifySessionError - generic Error returns failed", () => {
  const error = new Error("Something went wrong");
  assertEquals(classifySessionError(error), "failed");
});

Deno.test("classifySessionError - TypeError returns failed", () => {
  const error = new TypeError("Cannot read property of undefined");
  assertEquals(classifySessionError(error), "failed");
});

Deno.test("classifySessionError - string error returns failed", () => {
  assertEquals(classifySessionError("string error"), "failed");
});

Deno.test("classifySessionError - null returns failed", () => {
  assertEquals(classifySessionError(null), "failed");
});

Deno.test("classifySessionError - undefined returns failed", () => {
  assertEquals(classifySessionError(undefined), "failed");
});
