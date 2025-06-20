/**
 * HTTP Signal Provider - Built-in provider for basic HTTP endpoints
 * Handles simple HTTP signals with configurable methods and paths
 */

import type { HealthStatus, IProvider, ISignalProvider, ProviderState } from "../types.ts";
import { ProviderStatus, ProviderType } from "../types.ts";

export interface HTTPSignalConfig {
  id: string;
  description: string;
  provider: "http";
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
}

export interface HTTPRoutePattern {
  path: string;
  method: string;
  signalId: string;
}

export interface HTTPSignalData {
  id: string;
  type: string;
  timestamp: string;
  data: any;
}

/**
 * Built-in HTTP Signal Provider for basic HTTP endpoint signals
 */
export class HTTPSignalProvider implements IProvider {
  // IProvider interface properties
  readonly id: string;
  readonly type = ProviderType.SIGNAL;
  readonly name = "HTTP Signal Provider";
  readonly version = "1.0.0";

  private config: HTTPSignalConfig;
  private readonly allowedMethods = ["GET", "POST", "PUT", "DELETE"];
  private state: ProviderState;

  constructor(config: HTTPSignalConfig) {
    this.validateConfig(config);
    this.config = {
      ...config,
      method: config.method || "POST",
    };
    this.id = config.id;
    this.state = {
      status: ProviderStatus.NOT_CONFIGURED,
    };
  }

  private validateConfig(config: HTTPSignalConfig): void {
    if (!config.path) {
      throw new Error("HTTP signal provider requires 'path' configuration");
    }

    if (config.method && !this.allowedMethods.includes(config.method)) {
      throw new Error(
        `Invalid HTTP method '${config.method}'. Allowed: ${this.allowedMethods.join(", ")}`,
      );
    }
  }

  // IProvider interface methods
  setup(): void {
    this.state.status = ProviderStatus.READY;
    this.state.config = this.config;
  }

  teardown(): void {
    this.state.status = ProviderStatus.DISABLED;
  }

  getState(): ProviderState {
    return { ...this.state };
  }

  async checkHealth(): Promise<HealthStatus> {
    return {
      healthy: this.state.status === ProviderStatus.READY,
      lastCheck: new Date(),
      message: this.state.status === ProviderStatus.READY
        ? "HTTP signal provider ready"
        : `Provider status: ${this.state.status}`,
    };
  }

  /**
   * Get the provider ID
   */
  getProviderId(): string {
    return this.config.id;
  }

  /**
   * Get the provider type
   */
  getProviderType(): string {
    return "http";
  }

  /**
   * Get the HTTP method for this signal
   */
  getMethod(): string {
    return this.config.method || "POST";
  }

  /**
   * Generate route pattern for server registration
   */
  getRoutePattern(): HTTPRoutePattern {
    const path = this.config.path.startsWith("/") ? this.config.path : `/${this.config.path}`;

    return {
      path,
      method: this.getMethod(),
      signalId: this.config.id,
    };
  }

  /**
   * Process incoming HTTP request and convert to signal
   */
  async processRequest(request: Request): Promise<HTTPSignalData> {
    const url = new URL(request.url);
    const signal: HTTPSignalData = {
      id: this.config.id,
      type: "http",
      timestamp: new Date().toISOString(),
      data: {},
    };

    // Extract query parameters
    const queryParams: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      queryParams[key] = value;
    });

    if (Object.keys(queryParams).length > 0) {
      signal.data.query = queryParams;
    }

    // Extract headers (convert to lowercase for consistency)
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    if (Object.keys(headers).length > 0) {
      signal.data.headers = headers;
    }

    // Extract body for POST/PUT requests
    if (request.method === "POST" || request.method === "PUT") {
      try {
        const contentType = request.headers.get("content-type");

        if (contentType?.includes("application/json")) {
          const body = await request.text();
          if (body.trim()) {
            try {
              const parsedBody = JSON.parse(body);
              signal.data = { ...signal.data, ...parsedBody };
            } catch {
              // If JSON parsing fails, store as raw body
              signal.data.body = body;
            }
          }
        } else {
          const body = await request.text();
          if (body.trim()) {
            signal.data.body = body;
          }
        }
      } catch {
        // If body reading fails, continue without body
      }
    }

    return signal;
  }
}
