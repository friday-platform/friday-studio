/**
 * Tests for AtlasDaemon.maybeStartDiscordGateway + shutdown wiring. The full
 * daemon is integration-heavy, so these tests poke only the daemon-scoped
 * Discord Gateway service plumbing via narrow spies — no real WebSockets.
 */

import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtlasDaemon } from "./atlas-daemon.ts";
import { DiscordGatewayService } from "./discord-gateway-service.ts";

const discordEnvKeys = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_APPLICATION_ID",
] as const;

function saveDiscordEnv(): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of discordEnvKeys) saved[key] = process.env[key];
  return () => {
    for (const key of discordEnvKeys) {
      const original = saved[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  };
}

describe("AtlasDaemon.maybeStartDiscordGateway", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = saveDiscordEnv();
    for (const key of discordEnvKeys) delete process.env[key];
  });
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  // Private method surfaced for tests; cast is test-file-only.
  type GatewayShape = {
    maybeStartDiscordGateway: () => Promise<void>;
    discordGatewayService: DiscordGatewayService | null;
  };

  it("does NOT start the service when env vars are missing", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    const startSpy = vi.spyOn(DiscordGatewayService.prototype, "start").mockResolvedValue();

    await (daemon as unknown as GatewayShape).maybeStartDiscordGateway();

    expect(startSpy).not.toHaveBeenCalled();
    expect((daemon as unknown as GatewayShape).discordGatewayService).toBeNull();
  });

  it("starts the service whenever all three env vars are present — no workspace precondition", async () => {
    // The /signals/discord route handles "no workspace" with 404, so gating
    // startup on a discord signal would block users from adding one later
    // without a daemon restart.
    process.env.DISCORD_BOT_TOKEN = "t";
    process.env.DISCORD_PUBLIC_KEY = "k";
    process.env.DISCORD_APPLICATION_ID = "a";

    const daemon = new AtlasDaemon({ port: 0 });
    // `daemon.port` throws unless the server started; stub the getter.
    Object.defineProperty(daemon, "port", {
      get: () => 12345,
      configurable: true,
    });
    const startSpy = vi.spyOn(DiscordGatewayService.prototype, "start").mockResolvedValue();

    await (daemon as unknown as GatewayShape).maybeStartDiscordGateway();

    expect(startSpy).toHaveBeenCalledOnce();
    expect((daemon as unknown as GatewayShape).discordGatewayService).toBeInstanceOf(
      DiscordGatewayService,
    );
  });
});

describe("AtlasDaemon.shutdown stops the Discord Gateway service", () => {
  it("calls service.stop() during shutdown and clears the handle", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    const stop = vi.fn().mockResolvedValue(undefined);
    (daemon as unknown as { discordGatewayService: { stop: typeof stop } }).discordGatewayService =
      { stop };

    await daemon.shutdown();

    expect(stop).toHaveBeenCalledOnce();
    expect(
      (daemon as unknown as { discordGatewayService: DiscordGatewayService | null })
        .discordGatewayService,
    ).toBeNull();
  });
});
