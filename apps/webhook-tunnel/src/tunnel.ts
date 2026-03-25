/**
 * Cloudflared tunnel manager with automatic reconnection.
 *
 * Monitors the cloudflared child process and reconnects with exponential
 * backoff when it exits unexpectedly (e.g. laptop sleep, network change).
 * A periodic health probe verifies the tunnel is actually forwarding traffic.
 */

import { existsSync } from "node:fs";
import { logger } from "@atlas/logger";
import { bin, ConfigHandler, install, Tunnel, use } from "cloudflared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const HEALTH_PROBE_INTERVAL_MS = 30_000;
const MAX_CONSECUTIVE_PROBE_FAILURES = 2;
const STARTUP_URL_TIMEOUT_MS = 30_000;
const MAX_STARTUP_RETRIES = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TunnelManagerOptions {
  port: number;
  tunnelToken?: string;
}

export interface TunnelStatus {
  url: string | null;
  alive: boolean;
  restartCount: number;
  lastProbeAt: string | null;
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

async function ensureBinary(): Promise<void> {
  const systemPaths = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"];
  for (const p of systemPaths) {
    if (existsSync(p)) {
      use(p);
      logger.debug("Using system cloudflared", { path: p });
      return;
    }
  }

  if (!existsSync(bin)) {
    logger.info("Installing cloudflared binary...");
    await install(bin);
  }
  logger.debug("Using npm cloudflared", { path: bin });
}

// ---------------------------------------------------------------------------
// TunnelManager
// ---------------------------------------------------------------------------

export class TunnelManager {
  private readonly port: number;
  private readonly tunnelToken?: string;

  private tunnel: Tunnel | null = null;
  private _url: string | null = null;
  private _alive = false;
  private _restartCount = 0;
  private _lastProbeAt: Date | null = null;
  private _stopped = false;

  private _connectionCount = 0;
  private backoffMs = INITIAL_BACKOFF_MS;
  private consecutiveProbeFailures = 0;
  private _reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private probeInterval: ReturnType<typeof setInterval> | null = null;

  constructor(opts: TunnelManagerOptions) {
    this.port = opts.port;
    this.tunnelToken = opts.tunnelToken;
  }

  // ---- Public getters -----------------------------------------------------

  get url(): string | null {
    return this._url;
  }

  get alive(): boolean {
    return this._alive;
  }

  get status(): TunnelStatus {
    return {
      url: this._url,
      alive: this._alive,
      restartCount: this._restartCount,
      lastProbeAt: this._lastProbeAt?.toISOString() ?? null,
    };
  }

  // ---- Lifecycle ----------------------------------------------------------

  /**
   * Start the tunnel with retry logic for initial connection.
   * Retries with backoff if the network isn't available yet (laptop just woke up).
   */
  async start(): Promise<void> {
    await ensureBinary();

    let lastError: Error | null = null;
    let delay = INITIAL_BACKOFF_MS;

    for (let attempt = 1; attempt <= MAX_STARTUP_RETRIES; attempt++) {
      try {
        await this.connect();
        this.startHealthProbe();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_STARTUP_RETRIES) {
          logger.warn("Tunnel startup failed, retrying", {
            attempt,
            maxAttempts: MAX_STARTUP_RETRIES,
            nextRetryMs: delay,
            error: lastError.message,
          });
          await sleep(delay);
          delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        }
      }
    }

    throw lastError ?? new Error("Tunnel startup failed");
  }

  /** Gracefully stop the tunnel and all timers. */
  stop(): void {
    this._stopped = true;
    this.clearTimers();

    if (this.tunnel) {
      try {
        this.tunnel.stop();
      } catch {
        // Already dead — ignore
      }
      this.tunnel = null;
    }

    this._alive = false;
    logger.info("Tunnel manager stopped");
  }

  // ---- Internal: connection -----------------------------------------------

  private async connect(): Promise<void> {
    // Reset connection count — previous tunnel's count is stale.
    this._connectionCount = 0;

    const t = this.tunnelToken
      ? Tunnel.withToken(this.tunnelToken, { "--url": `http://localhost:${this.port}` })
      : Tunnel.quick(`http://localhost:${this.port}`);

    // Token tunnels need ConfigHandler to emit the "url" event — the default
    // handlers only include TryCloudflareHandler (matches *.trycloudflare.com).
    // ConfigHandler parses cloudflared's config output and emits "url" for
    // each ingress hostname.
    if (this.tunnelToken) {
      new ConfigHandler(t);
    }

    // Exit handler — only wired AFTER successful URL (see below). During the
    // URL await, intentional t.stop() calls in reject paths must not trigger
    // scheduleReconnect.
    const exitHandler = (code: number | null, signal: string | null) => {
      if (this._stopped || this._reconnecting || this.tunnel !== t) return;
      logger.warn("Cloudflared process exited unexpectedly", { code, signal });
      this._alive = false;
      this.scheduleReconnect();
    };

    // Connection tracking — cloudflared maintains multiple edge connections.
    // Track count so a single blip doesn't look like a full outage.
    // All listeners gate on `this.tunnel === t` so stale tunnels from failed
    // connect() attempts can't mutate shared state.
    t.on("error", (err: Error) => {
      if (this._stopped || this.tunnel !== t) return;
      logger.warn("Cloudflared process error", { error: err.message });
    });

    t.on("disconnected", () => {
      if (this._stopped || this.tunnel !== t) return;
      this._connectionCount = Math.max(0, this._connectionCount - 1);
      logger.warn("Cloudflared edge connection lost", { remaining: this._connectionCount });
    });

    t.on("connected", () => {
      if (this._stopped || this.tunnel !== t) return;
      this._connectionCount++;
      logger.info("Cloudflared edge connection established", { total: this._connectionCount });
    });

    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        t.stop(); // Kill orphaned cloudflared process
        reject(new Error("Timed out waiting for cloudflared tunnel URL"));
      }, STARTUP_URL_TIMEOUT_MS);

      t.once("url", (u: string) => {
        clearTimeout(timeout);
        resolve(u);
      });

      t.once("error", (err: Error) => {
        clearTimeout(timeout);
        t.stop(); // Kill orphaned cloudflared process
        reject(err);
      });
    });

    // URL received — tunnel is alive. Wire up exit handler NOW so intentional
    // kills during the await above don't trigger spurious reconnects.
    t.on("exit", exitHandler);

    this.tunnel = t;
    this._url = url;
    this._alive = true;
    this._connectionCount = Math.max(this._connectionCount, 1);
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.consecutiveProbeFailures = 0;
    this._reconnecting = false;
  }

  // ---- Internal: reconnection ---------------------------------------------

  private scheduleReconnect(): void {
    if (this._stopped || this._reconnecting) return;
    this._reconnecting = true;
    this.clearTimers();

    logger.info("Scheduling tunnel reconnect", { delayMs: this.backoffMs });

    this.reconnectTimer = setTimeout(async () => {
      if (this._stopped) return;

      this._restartCount++;
      logger.info("Reconnecting tunnel", { attempt: this._restartCount });

      try {
        // Clean up old tunnel
        if (this.tunnel) {
          try {
            this.tunnel.stop();
          } catch {
            // Already dead
          }
          this.tunnel = null;
        }

        await this.connect();
        this.startHealthProbe();

        logger.info("Tunnel reconnected", { url: this._url, restartCount: this._restartCount });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Tunnel reconnect failed", { error: msg, nextRetryMs: this.backoffMs });
        this._alive = false;
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
        this._reconnecting = false; // Allow scheduleReconnect to fire again
        this.scheduleReconnect();
      }
    }, this.backoffMs);
  }

  // ---- Internal: health probe ---------------------------------------------

  private startHealthProbe(): void {
    if (this.probeInterval) clearInterval(this.probeInterval);

    this.probeInterval = setInterval(() => {
      if (this._stopped || !this._url) return;
      this.probe();
    }, HEALTH_PROBE_INTERVAL_MS);
  }

  private probe(): void {
    this._lastProbeAt = new Date();

    // 1. Check that the cloudflared child process is still running.
    const proc = this.tunnel?.process;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      this.handleProbeFailure("cloudflared process is not running");
      return;
    }

    // 2. Check that cloudflared has at least one active edge connection.
    //    The process can be alive but fully disconnected (e.g. after laptop
    //    sleep where all QUIC connections went stale but the process didn't exit).
    if (this._connectionCount <= 0) {
      this.handleProbeFailure("cloudflared process alive but no edge connections");
      return;
    }

    // Both checks pass — tunnel is healthy
    if (this.consecutiveProbeFailures > 0) {
      logger.info("Tunnel health probe recovered");
    }
    this.consecutiveProbeFailures = 0;
    this._alive = true;
  }

  private handleProbeFailure(reason: string): void {
    this.consecutiveProbeFailures++;
    logger.warn("Tunnel health probe failed", {
      reason,
      consecutive: this.consecutiveProbeFailures,
      threshold: MAX_CONSECUTIVE_PROBE_FAILURES,
    });

    if (this.consecutiveProbeFailures >= MAX_CONSECUTIVE_PROBE_FAILURES) {
      logger.error("Tunnel appears dead, triggering reconnect");
      this._alive = false;

      // Kill the old tunnel and reconnect
      if (this.tunnel) {
        try {
          this.tunnel.stop();
        } catch {
          // Already dead
        }
        this.tunnel = null;
      }

      this.scheduleReconnect();
    }
  }

  // ---- Internal: cleanup --------------------------------------------------

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.probeInterval) {
      clearInterval(this.probeInterval);
      this.probeInterval = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
