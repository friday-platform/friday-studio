import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnalyticsClient } from "./client.ts";
import { EventNames } from "./types.ts";

describe("createAnalyticsClient", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.ANALYTICS_OTEL_ENDPOINT;
    // Clear environment to ensure analytics is disabled for most tests
    delete process.env.ANALYTICS_OTEL_ENDPOINT;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.ANALYTICS_OTEL_ENDPOINT = originalEnv;
    } else {
      delete process.env.ANALYTICS_OTEL_ENDPOINT;
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
      process.env.ANALYTICS_OTEL_ENDPOINT = "http://localhost:4318/v1/logs";
      const client = createAnalyticsClient();

      expect(() => {
        client.emit({
          eventName: EventNames.CONVERSATION_STARTED,
          // @ts-expect-error - testing missing userId
          userId: undefined,
        });
      }).toThrow("missing userId");
    });

    it("throws when userId is empty string", () => {
      process.env.ANALYTICS_OTEL_ENDPOINT = "http://localhost:4318/v1/logs";
      const client = createAnalyticsClient();

      expect(() => {
        client.emit({ eventName: EventNames.WORKSPACE_CREATED, userId: "" });
      }).toThrow("missing userId");
    });

    it("throws when userId is whitespace only", () => {
      process.env.ANALYTICS_OTEL_ENDPOINT = "http://localhost:4318/v1/logs";
      const client = createAnalyticsClient();

      expect(() => {
        client.emit({ eventName: EventNames.JOB_DEFINED, userId: "   " });
      }).toThrow("missing userId");
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
    expect(EventNames.USER_SIGNED_UP).toEqual("user.signed_up");
    expect(EventNames.USER_PROFILE_COMPLETED).toEqual("user.profile_completed");
    expect(EventNames.USER_LOGGED_IN).toEqual("user.logged_in");
    expect(EventNames.CONVERSATION_STARTED).toEqual("conversation.started");
    expect(EventNames.WORKSPACE_CREATED).toEqual("workspace.created");
    expect(EventNames.JOB_DEFINED).toEqual("job.defined");
    expect(EventNames.SESSION_STARTED).toEqual("session.started");
    expect(EventNames.SESSION_COMPLETED).toEqual("session.completed");
    expect(EventNames.SESSION_FAILED).toEqual("session.failed");
  });
});
