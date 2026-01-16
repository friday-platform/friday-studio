import { assertEquals, assertThrows } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { createAnalyticsClient } from "./client.ts";
import { EventNames } from "./types.ts";

describe("createAnalyticsClient", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = Deno.env.get("ANALYTICS_OTEL_ENDPOINT");
    // Clear environment to ensure analytics is disabled for most tests
    Deno.env.delete("ANALYTICS_OTEL_ENDPOINT");
  });

  afterEach(() => {
    if (originalEnv) {
      Deno.env.set("ANALYTICS_OTEL_ENDPOINT", originalEnv);
    }
  });

  describe("emit()", () => {
    it("does not throw when analytics is disabled (no endpoint)", () => {
      const client = createAnalyticsClient();
      // Should not throw when endpoint not configured
      client.emit({
        eventName: EventNames.CONVERSATION_STARTED,
        userId: "user-123",
        workspaceId: "ws-456",
      });
    });

    it("throws when userId is missing", () => {
      // Set endpoint to enable validation
      Deno.env.set("ANALYTICS_OTEL_ENDPOINT", "http://localhost:4318/v1/logs");
      const client = createAnalyticsClient();

      assertThrows(
        () => {
          client.emit({
            eventName: EventNames.CONVERSATION_STARTED,
            // @ts-expect-error - testing missing userId
            userId: undefined,
          });
        },
        Error,
        "missing userId",
      );
    });

    it("throws when userId is empty string", () => {
      Deno.env.set("ANALYTICS_OTEL_ENDPOINT", "http://localhost:4318/v1/logs");
      const client = createAnalyticsClient();

      assertThrows(
        () => {
          client.emit({ eventName: EventNames.WORKSPACE_CREATED, userId: "" });
        },
        Error,
        "missing userId",
      );
    });

    it("throws when userId is whitespace only", () => {
      Deno.env.set("ANALYTICS_OTEL_ENDPOINT", "http://localhost:4318/v1/logs");
      const client = createAnalyticsClient();

      assertThrows(
        () => {
          client.emit({ eventName: EventNames.JOB_DEFINED, userId: "   " });
        },
        Error,
        "missing userId",
      );
    });
  });

  describe("shutdown()", () => {
    it("does not throw when analytics is disabled", async () => {
      const client = createAnalyticsClient();
      // Should not throw
      await client.shutdown();
    });
  });
});

describe("EventNames", () => {
  it("has expected event names", () => {
    assertEquals(EventNames.USER_SIGNED_UP, "user.signed_up");
    assertEquals(EventNames.USER_PROFILE_COMPLETED, "user.profile_completed");
    assertEquals(EventNames.USER_LOGGED_IN, "user.logged_in");
    assertEquals(EventNames.CONVERSATION_STARTED, "conversation.started");
    assertEquals(EventNames.WORKSPACE_CREATED, "workspace.created");
    assertEquals(EventNames.JOB_DEFINED, "job.defined");
    assertEquals(EventNames.SESSION_STARTED, "session.started");
    assertEquals(EventNames.SESSION_COMPLETED, "session.completed");
    assertEquals(EventNames.SESSION_FAILED, "session.failed");
  });
});
