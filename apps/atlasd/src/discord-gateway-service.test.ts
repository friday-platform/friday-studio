/**
 * Tests for the daemon-scoped `DiscordGatewayService`. Stubs
 * `startGatewayListener` via `adapterFactory` — no real WebSocket or HTTP.
 */

import type { Logger } from "@atlas/logger";
import type { DiscordAdapter } from "@chat-adapter/discord";
import type { WebhookOptions } from "chat";
import { describe, expect, it, vi } from "vitest";
import { DiscordGatewayService } from "./discord-gateway-service.ts";

function makeSilentLogger(): Logger {
  const noop = vi.fn();
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

type StartFn = DiscordAdapter["startGatewayListener"];

function makeFakeAdapter(start: ReturnType<typeof vi.fn<StartFn>>): DiscordAdapter {
  return {
    name: "discord",
    initialize: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    startGatewayListener: start,
  } as unknown as DiscordAdapter;
}

const credentials = {
  botToken: "bot-token",
  publicKey: "public-key",
  applicationId: "app-123",
};

describe("DiscordGatewayService", () => {
  it("calls startGatewayListener with the forwardUrl when started", async () => {
    const start = vi.fn<StartFn>(
      // deno-lint-ignore require-await
      async (
        options: WebhookOptions,
        _duration?: number,
        abortSignal?: AbortSignal,
      ): Promise<Response> => {
        options.waitUntil?.(
          new Promise<void>((resolve) => {
            abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        );
        return new Response();
      },
    );
    const adapter = makeFakeAdapter(start);

    const service = new DiscordGatewayService({
      credentials,
      forwardUrl: "http://localhost:12345/platform/discord",
      logger: makeSilentLogger(),
      adapterFactory: () => adapter,
    });

    await service.start();
    await vi.waitFor(() => expect(start).toHaveBeenCalled());

    const [, , , webhookUrl] = start.mock.calls[0] ?? [];
    expect(webhookUrl).toBe("http://localhost:12345/platform/discord");

    await service.stop();
  });

  it("stops cleanly — abort fires and the in-flight listener settles before stop resolves", async () => {
    let settled = false;
    const start = vi.fn<StartFn>(
      // deno-lint-ignore require-await
      async (
        options: WebhookOptions,
        _duration?: number,
        abortSignal?: AbortSignal,
      ): Promise<Response> => {
        options.waitUntil?.(
          new Promise<void>((resolve) => {
            abortSignal?.addEventListener(
              "abort",
              () => {
                setTimeout(() => {
                  settled = true;
                  resolve();
                }, 20);
              },
              { once: true },
            );
          }),
        );
        return new Response();
      },
    );
    const adapter = makeFakeAdapter(start);

    const service = new DiscordGatewayService({
      credentials,
      forwardUrl: "http://localhost:1/platform/discord",
      logger: makeSilentLogger(),
      adapterFactory: () => adapter,
    });
    await service.start();
    await vi.waitFor(() => expect(start).toHaveBeenCalled());

    await service.stop();
    expect(settled).toBe(true);
  });

  it("stops permanently on auth error — no retry loop", async () => {
    // deno-lint-ignore require-await
    const start = vi.fn<StartFn>(async (): Promise<Response> => {
      throw new Error("An invalid token was provided.");
    });
    const adapter = makeFakeAdapter(start);

    const logger = makeSilentLogger();
    const errorSpy = vi.spyOn(logger, "error");
    const service = new DiscordGatewayService({
      credentials,
      forwardUrl: "http://localhost:1/platform/discord",
      logger,
      adapterFactory: () => adapter,
    });
    await service.start();
    await service.stop();

    expect(start).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "discord_gateway_auth_failed",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("is idempotent — start() twice only boots the loop once", async () => {
    const start = vi.fn<StartFn>(
      // deno-lint-ignore require-await
      async (
        options: WebhookOptions,
        _duration?: number,
        abortSignal?: AbortSignal,
      ): Promise<Response> => {
        options.waitUntil?.(
          new Promise<void>((resolve) => {
            abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        );
        return new Response();
      },
    );
    const adapter = makeFakeAdapter(start);
    const service = new DiscordGatewayService({
      credentials,
      forwardUrl: "http://localhost:1/platform/discord",
      logger: makeSilentLogger(),
      adapterFactory: () => adapter,
    });

    await service.start();
    await service.start();
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    // Only one listener running (the loop gated on `loopPromise` being set).
    expect(start).toHaveBeenCalledTimes(1);
    await service.stop();
  });
});
