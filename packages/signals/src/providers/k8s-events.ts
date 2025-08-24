/**
 * Kubernetes Events Signal Provider for Atlas
 * Provides direct integration with Kubernetes Events API for real-time event streaming
 */

import { AtlasScope } from "../../../../src/core/scope.ts";
import { type K8sAuthConfig, K8sAuthManager } from "./k8s-auth.ts";
import {
  type HealthStatus,
  type IProviderSignal,
  type ISignalProvider,
  type ProviderState,
  ProviderStatus,
  ProviderType,
} from "./types.ts";

// SECURITY: Secure logging utilities to prevent credential exposure
class SecureLogger {
  static sanitizeForLogging(obj: unknown): unknown {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === "string") {
      // Check for potential credentials in strings
      if (
        obj.length > 100 ||
        obj.match(/^[A-Za-z0-9+/]+=*$/) ||
        obj.includes("token") ||
        obj.includes("key")
      ) {
        return "[REDACTED]";
      }
      return obj;
    }

    if (typeof obj === "object") {
      const sensitiveKeys = [
        "token",
        "password",
        "key",
        "secret",
        "auth",
        "authorization",
        "bearer",
        "credential",
        "cert",
        "certificate",
        "private",
      ];

      if (Array.isArray(obj)) {
        return obj.map((item) => SecureLogger.sanitizeForLogging(item));
      }

      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        const keyLower = key.toLowerCase();
        if (sensitiveKeys.some((sensitive) => keyLower.includes(sensitive))) {
          sanitized[key] = "[REDACTED]";
        } else {
          sanitized[key] = SecureLogger.sanitizeForLogging(value);
        }
      }
      return sanitized;
    }

    return obj;
  }

  static secureLog(level: "info" | "warn" | "error", message: string, data?: unknown): void {
    const sanitizedData = data ? SecureLogger.sanitizeForLogging(data) : undefined;
    if (level === "error") {
      if (sanitizedData !== undefined) {
        console.error(message, sanitizedData);
      } else {
        console.error(message);
      }
    } else if (level === "warn") {
      if (sanitizedData !== undefined) {
        console.warn(message, sanitizedData);
      } else {
        console.warn(message);
      }
    } else {
      if (sanitizedData !== undefined) {
        console.log(message, sanitizedData);
      } else {
        console.log(message);
      }
    }
  }
}

// Minimal types for Kubernetes Events only
interface K8sWatchEvent {
  type: "ADDED" | "MODIFIED" | "DELETED" | "ERROR" | "BOOKMARK";
  object: K8sEvent;
}

interface K8sEvent {
  metadata?: { name?: string; namespace?: string; resourceVersion: string };
  reason: string;
  message: string;
  type?: string;
  count?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  involvedObject?: { kind: string; name: string; namespace?: string };
  source?: { component?: string; host?: string };
}

export interface K8sEventsSignalConfig {
  // Kubernetes API configuration - flexible kubeconfig support
  kubeconfig?: string; // Path to kubeconfig file
  kubeconfig_content?: string; // Embedded kubeconfig YAML content
  kubeconfig_env?: string; // Environment variable containing kubeconfig
  use_service_account?: boolean; // Use in-cluster service account

  // Direct API configuration (alternative to kubeconfig)
  api_server?: string;
  token?: string;
  ca_cert?: string;
  insecure?: boolean;

  // Event watching configuration
  namespace?: string; // Specific namespace (empty = all namespaces)

  // Connection settings
  timeout_ms?: number;
  retry_config?: { max_retries: number; retry_delay_ms: number };
}

export class K8sEventsSignalProvider implements ISignalProvider {
  readonly type = ProviderType.SIGNAL;
  readonly id = "k8s-events";
  readonly name = "Kubernetes Events Signal Provider";
  readonly version = "1.0.0";

  private state: ProviderState = { status: ProviderStatus.NOT_CONFIGURED };

  setup(): Promise<void> {
    this.state.status = ProviderStatus.READY;
    return Promise.resolve();
  }

  teardown(): Promise<void> {
    this.state.status = ProviderStatus.DISABLED;
    return Promise.resolve();
  }

  getState(): ProviderState {
    return this.state;
  }

  checkHealth(): Promise<HealthStatus> {
    return Promise.resolve({
      healthy: this.state.status === ProviderStatus.READY,
      message: `Kubernetes events provider is ${this.state.status}`,
      lastCheck: new Date(),
    });
  }

  // SECURITY FIX: Add input validation before creating signal
  createSignal(config: K8sEventsSignalConfig): IProviderSignal {
    this.validateConfig(config);
    return new K8sEventsProviderSignal(this.id, config);
  }

  // SECURITY FIX: Comprehensive configuration validation
  private validateConfig(config: K8sEventsSignalConfig): void {
    if (!config || typeof config !== "object") {
      throw new Error("Invalid configuration object");
    }

    // Validate namespace if provided
    if (config.namespace !== undefined) {
      if (typeof config.namespace !== "string") {
        throw new Error("Namespace must be a string");
      }
      // Kubernetes namespace naming rules
      if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(config.namespace)) {
        throw new Error("Invalid namespace format. Must follow Kubernetes naming conventions.");
      }
      if (config.namespace.length > 63) {
        throw new Error("Namespace name too long (max 63 characters)");
      }
    }

    // Validate timeout
    if (config.timeout_ms !== undefined) {
      if (
        typeof config.timeout_ms !== "number" ||
        config.timeout_ms < 1000 ||
        config.timeout_ms > 300000
      ) {
        throw new Error("Timeout must be between 1000ms and 300000ms (5 minutes)");
      }
    }

    // Validate retry configuration
    if (config.retry_config) {
      if (typeof config.retry_config !== "object") {
        throw new Error("Retry config must be an object");
      }

      if (config.retry_config.max_retries !== undefined) {
        if (
          typeof config.retry_config.max_retries !== "number" ||
          config.retry_config.max_retries < 0 ||
          config.retry_config.max_retries > 10
        ) {
          throw new Error("Max retries must be between 0 and 10");
        }
      }

      if (config.retry_config.retry_delay_ms !== undefined) {
        if (
          typeof config.retry_config.retry_delay_ms !== "number" ||
          config.retry_config.retry_delay_ms < 100 ||
          config.retry_config.retry_delay_ms > 60000
        ) {
          throw new Error("Retry delay must be between 100ms and 60000ms (1 minute)");
        }
      }
    }

    // Validate kubeconfig paths
    if (config.kubeconfig !== undefined) {
      if (typeof config.kubeconfig !== "string" || config.kubeconfig.length === 0) {
        throw new Error("Kubeconfig path must be a non-empty string");
      }
    }

    if (config.kubeconfig_env !== undefined) {
      if (
        typeof config.kubeconfig_env !== "string" ||
        !/^[A-Z_][A-Z0-9_]*$/i.test(config.kubeconfig_env)
      ) {
        throw new Error("Invalid environment variable name for kubeconfig");
      }
    }

    // Validate API server URL if provided
    if (config.api_server !== undefined) {
      if (typeof config.api_server !== "string") {
        throw new Error("API server must be a string");
      }
      try {
        const url = new URL(config.api_server);
        if (!["https:", "http:"].includes(url.protocol)) {
          throw new Error("API server must use HTTP or HTTPS protocol");
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("HTTP or HTTPS")) {
          throw error; // Re-throw protocol validation errors
        }
        throw new Error("Invalid API server URL format");
      }
    }

    // Validate insecure flag
    if (config.insecure !== undefined && typeof config.insecure !== "boolean") {
      throw new Error("Insecure flag must be a boolean");
    }
  }
}

class K8sEventsProviderSignal implements IProviderSignal {
  readonly id: string;
  readonly providerId: string;
  readonly config: K8sEventsSignalConfig;

  constructor(providerId: string, config: K8sEventsSignalConfig) {
    this.id = `${providerId}-events`;
    this.providerId = providerId;
    this.config = config;
  }

  validate(): boolean {
    // Validate auth configuration
    const hasKubeconfig = !!(
      this.config.kubeconfig ||
      this.config.kubeconfig_content ||
      this.config.kubeconfig_env ||
      this.config.use_service_account
    );

    const hasDirectConfig = !!(this.config.api_server && this.config.token);

    return hasKubeconfig || hasDirectConfig;
  }

  toRuntimeSignal(): K8sEventsRuntimeSignal {
    return new K8sEventsRuntimeSignal(this.providerId, this.config);
  }
}

class K8sEventsRuntimeSignal extends AtlasScope {
  private abortController?: AbortController;
  private signalProcessor?: (signalId: string, payload: unknown) => Promise<void>;
  private signalId?: string;
  private isConnected = false;
  private authConfig?: K8sAuthConfig;

  constructor(
    private providerId: string,
    private config: K8sEventsSignalConfig,
  ) {
    super(`${providerId}-k8s-events-signal`);
  }

  async initialize(context: {
    id: string;
    processSignal: (signalId: string, payload: unknown) => Promise<void>;
  }): Promise<void> {
    this.signalId = context.id;
    this.signalProcessor = context.processSignal;

    // Initialize authentication
    this.authConfig = await this.initializeAuth();

    // Start watching Kubernetes events
    await this.startWatching();
  }

  private async initializeAuth(): Promise<K8sAuthConfig> {
    // Try different auth methods in order of preference
    if (this.config.use_service_account) {
      return await K8sAuthManager.loadFromServiceAccount();
    }

    if (this.config.kubeconfig_content) {
      return await K8sAuthManager.loadFromKubeconfigContent(this.config.kubeconfig_content);
    }

    if (this.config.kubeconfig_env) {
      const content = Deno.env.get(this.config.kubeconfig_env);
      if (!content) {
        throw new Error(`Environment variable ${this.config.kubeconfig_env} not found`);
      }
      return await K8sAuthManager.loadFromKubeconfigContent(content);
    }

    if (this.config.kubeconfig) {
      return await K8sAuthManager.loadFromKubeconfigFile(this.config.kubeconfig);
    }

    if (this.config.api_server && this.config.token) {
      return {
        server: this.config.api_server,
        token: this.config.token,
        ca: this.config.ca_cert,
        insecure: this.config.insecure || false,
      };
    }

    // Fallback to default kubeconfig
    return await K8sAuthManager.loadFromKubeconfigFile();
  }

  private startWatching(): Promise<void> {
    SecureLogger.secureLog("info", "🔍 Starting Kubernetes Events watch");

    this.abortController = new AbortController();

    // Start watching events in the background
    this.watchEvents(this.abortController.signal).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      SecureLogger.secureLog("error", `Failed to watch Kubernetes events: ${errorMessage}`);
    });

    this.isConnected = true;
    SecureLogger.secureLog("info", `✅ Kubernetes events signal '${this.signalId}' initialized`);
    return Promise.resolve();
  }

  private async watchEvents(signal: AbortSignal): Promise<void> {
    if (!this.authConfig) {
      throw new Error("Auth config not initialized");
    }

    const watchUrl = this.buildWatchUrl();

    // SECURITY FIX: Don't log full URL as it might contain sensitive info
    const safeUrl = watchUrl.replace(/\/\/[^@]*@/, "//[REDACTED]@");
    SecureLogger.secureLog("info", `🔍 Watching Kubernetes Events at ${safeUrl}`);

    const retryConfig = this.config.retry_config || { max_retries: 5, retry_delay_ms: 1000 };

    let retryCount = 0;

    while (!signal.aborted && retryCount <= retryConfig.max_retries) {
      try {
        await this.performWatch(watchUrl, signal);
        break; // Successful watch completed
      } catch (error) {
        if (signal.aborted) {
          break;
        }

        retryCount++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        SecureLogger.secureLog(
          "error",
          `Kubernetes events watch failed (attempt ${retryCount}/${
            retryConfig.max_retries + 1
          }): ${errorMessage}`,
        );

        if (retryCount <= retryConfig.max_retries) {
          await new Promise((resolve) => setTimeout(resolve, retryConfig.retry_delay_ms));
        }
      }
    }
  }

  private async performWatch(url: string, signal: AbortSignal): Promise<void> {
    if (!this.authConfig) {
      throw new Error("Auth config not initialized");
    }

    const headers = K8sAuthManager.createAuthHeaders(this.authConfig);

    // Build fetch options with proper SSL handling
    const fetchOptions: RequestInit & { client?: Deno.HttpClient } = { headers, signal };

    // SECURITY FIX: Secure TLS configuration with strict validation
    const clientOptions: Deno.CreateHttpClientOptions & { cert?: string; key?: string } = {};

    // Handle client certificates for authentication
    if (this.authConfig.cert && this.authConfig.key) {
      clientOptions.cert = this.authConfig.cert;
      clientOptions.key = this.authConfig.key;
    }

    // SECURITY FIX: Only allow insecure connections in development mode with explicit warning
    const isDevelopment =
      Deno.env.get("NODE_ENV") === "development" || Deno.env.get("DENO_ENV") === "development";

    if (this.authConfig.insecure || this.config.insecure) {
      if (!isDevelopment) {
        throw new Error(
          "Insecure TLS connections are not allowed in production. " +
            "Set NODE_ENV=development to enable for local development only.",
        );
      }

      SecureLogger.secureLog("warn", "⚠️  Using insecure TLS connection - DEVELOPMENT ONLY");
      SecureLogger.secureLog(
        "warn",
        "⚠️  This connection is vulnerable to man-in-the-middle attacks",
      );
      clientOptions.allowHost = true;
    } else if (this.authConfig.ca) {
      // Use provided CA certificate
      clientOptions.caCerts = [this.authConfig.ca];
    } else {
      // Use system CA certificates (most secure)
      SecureLogger.secureLog("info", "Using system CA certificates for TLS validation");
    }

    // Create client if we have any special options
    if (Object.keys(clientOptions).length > 0) {
      const client = Deno.createHttpClient(clientOptions);
      fetchOptions.client = client;
    }

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      SecureLogger.secureLog("info", `✅ Connected to Kubernetes Events API (${response.status})`);
    } catch (fetchError) {
      const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
      SecureLogger.secureLog("error", `❌ Failed to connect to Kubernetes API: ${errorMessage}`);

      // Add specific debugging for common issues
      if (errorMessage.includes("certificate")) {
        SecureLogger.secureLog(
          "error",
          "💡 Certificate issue detected. Check kubeconfig client certificates.",
        );
      } else if (errorMessage.includes("connection")) {
        SecureLogger.secureLog(
          "error",
          "💡 Connection issue detected. Check if Kubernetes API server is accessible.",
        );
      } else if (errorMessage.includes("403") || errorMessage.includes("Forbidden")) {
        SecureLogger.secureLog(
          "error",
          "💡 Authentication issue detected. Check kubeconfig credentials.",
        );
      }

      throw fetchError;
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            await this.processWatchEvent(line);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private buildWatchUrl(): string {
    if (!this.authConfig) {
      throw new Error("Auth config not initialized");
    }

    const baseUrl = this.authConfig.server;
    const apiPath = "/api/v1";

    // SECURITY FIX: Validate namespace parameter to prevent URL injection
    if (this.config.namespace) {
      // Re-validate namespace at runtime (belt and suspenders approach)
      if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(this.config.namespace)) {
        throw new Error("Invalid namespace format detected during URL building");
      }
      // URL encode the namespace to prevent injection
      const safeNamespace = encodeURIComponent(this.config.namespace);
      return `${baseUrl}${apiPath}/watch/namespaces/${safeNamespace}/events`;
    } else {
      return `${baseUrl}${apiPath}/watch/events`;
    }
  }

  private async processWatchEvent(line: string): Promise<void> {
    if (!this.signalProcessor) {
      return;
    }

    try {
      const event: K8sWatchEvent = JSON.parse(line);

      // Handle different event types
      if (event.type === "ERROR") {
        // SECURITY FIX: Sanitize error object before logging
        SecureLogger.secureLog("error", "Kubernetes events watch error", event.object);
        return;
      }

      if (event.type === "BOOKMARK") {
        // Bookmark events are for efficient re-watching, just log for now
        SecureLogger.secureLog(
          "info",
          `Events bookmark: ${event.object.metadata?.resourceVersion}`,
        );
        return;
      }

      // Process Kubernetes event
      const k8sEvent = event.object as K8sEvent;
      const eventData = {
        type: event.type, // ADDED, MODIFIED, DELETED
        event: {
          name: k8sEvent.metadata?.name,
          namespace: k8sEvent.metadata?.namespace,
          reason: k8sEvent.reason,
          message: k8sEvent.message,
          type: k8sEvent.type,
          count: k8sEvent.count,
          firstTimestamp: k8sEvent.firstTimestamp,
          lastTimestamp: k8sEvent.lastTimestamp,
          involvedObject: k8sEvent.involvedObject,
          source: k8sEvent.source,
        },
        timestamp: new Date().toISOString(),
      };

      SecureLogger.secureLog(
        "info",
        `📡 K8s Event ${event.type}: ${k8sEvent.reason} - ${k8sEvent.involvedObject?.kind}/${k8sEvent.involvedObject?.name}`,
      );

      await this.signalProcessor(this.signalId!, eventData);
    } catch (error) {
      // SECURITY FIX: Sanitize error before logging
      SecureLogger.secureLog("error", "Failed to process Kubernetes event", error);
    }
  }

  teardown(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.isConnected = false;

    SecureLogger.secureLog("info", `🔌 Kubernetes events signal '${this.signalId}' disconnected`);
    return Promise.resolve();
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }
}
