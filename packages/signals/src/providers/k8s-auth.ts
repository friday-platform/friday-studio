/**
 * Kubernetes Authentication Manager
 * Handles various Kubernetes authentication methods including kubeconfig parsing
 */

import { parse as parseYaml } from "@std/yaml";
import { join } from "@std/path";

export interface K8sAuthConfig {
  server: string;
  token?: string;
  cert?: string;
  key?: string;
  ca?: string;
  insecure?: boolean;
}

interface KubeconfigContext {
  cluster: string;
  user: string;
  namespace?: string;
}

interface KubeconfigCluster {
  server: string;
  "certificate-authority"?: string;
  "certificate-authority-data"?: string;
  "insecure-skip-tls-verify"?: boolean;
}

interface KubeconfigUser {
  token?: string;
  "client-certificate"?: string;
  "client-certificate-data"?: string;
  "client-key"?: string;
  "client-key-data"?: string;
  exec?: {
    command: string;
    args?: string[];
    env?: Array<{ name: string; value: string }>;
  };
}

interface KubeconfigFile {
  "current-context"?: string;
  contexts?: Array<{
    name: string;
    context: KubeconfigContext;
  }>;
  clusters?: Array<{
    name: string;
    cluster: KubeconfigCluster;
  }>;
  users?: Array<{
    name: string;
    user: KubeconfigUser;
  }>;
}

export class K8sAuthManager {
  /**
   * SECURITY: Validate file path to prevent path traversal attacks
   */
  private static validateCertificatePath(filePath: string): string {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("Invalid file path");
    }

    // Resolve the path to detect traversal attempts
    const resolvedPath = new URL(`file://${filePath}`).pathname;

    // Check for path traversal patterns
    if (
      filePath.includes("..") ||
      filePath.includes("~") ||
      resolvedPath.includes("..")
    ) {
      throw new Error("Path traversal detected in certificate path");
    }

    // Only allow paths that look like certificate files
    const allowedExtensions = [".crt", ".pem", ".cert", ".key"];
    const hasValidExtension = allowedExtensions.some((ext) => filePath.toLowerCase().endsWith(ext));

    if (!hasValidExtension) {
      throw new Error("Invalid certificate file extension");
    }

    // Restrict to reasonable paths (no system directories)
    const dangerousPaths = ["/etc/", "/sys/", "/proc/", "/dev/", "/root/"];
    for (const dangerous of dangerousPaths) {
      if (resolvedPath.startsWith(dangerous)) {
        throw new Error("Access to system directories not allowed");
      }
    }

    return resolvedPath;
  }

  /**
   * SECURITY: Safe file reading with additional validation
   */
  private static async readCertificateFile(filePath: string): Promise<string> {
    const safePath = this.validateCertificatePath(filePath);

    try {
      // Check if file exists and is readable
      const stat = await Deno.stat(safePath);

      // Ensure it's a regular file, not a directory or special file
      if (!stat.isFile) {
        throw new Error("Path is not a regular file");
      }

      // Check file size (prevent reading huge files)
      const maxSize = 1024 * 1024; // 1MB max for cert files
      if (stat.size > maxSize) {
        throw new Error("Certificate file too large");
      }

      const content = await Deno.readTextFile(safePath);

      // Basic validation that it looks like a certificate/key
      if (content.includes("-----BEGIN") && content.includes("-----END")) {
        return content;
      } else {
        throw new Error("File does not appear to be a valid certificate");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read certificate file: ${errorMessage}`);
    }
  }

  /**
   * Load authentication from kubeconfig file
   */
  static async loadFromKubeconfigFile(
    kubeconfigPath?: string,
  ): Promise<K8sAuthConfig> {
    // Cross-platform tilde expansion
    const path = kubeconfigPath
      ? kubeconfigPath.replace(/^~/, this.getHomeDir())
      : this.getDefaultKubeconfigPath();

    try {
      const content = await Deno.readTextFile(path);
      return await this.loadFromKubeconfigContent(content);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to read kubeconfig from ${path}: ${errorMessage}`,
      );
    }
  }

  /**
   * Load authentication from kubeconfig YAML content
   */
  static async loadFromKubeconfigContent(
    content: string,
  ): Promise<K8sAuthConfig> {
    try {
      const kubeconfig = parseYaml(content) as KubeconfigFile;
      return await this.parseKubeconfig(kubeconfig);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse kubeconfig: ${errorMessage}`);
    }
  }

  /**
   * Load authentication from in-cluster service account
   */
  static async loadFromServiceAccount(): Promise<K8sAuthConfig> {
    const tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
    const caPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
    const _namespacePath = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

    try {
      // Check if we're in a pod with service account
      const tokenStat = await Deno.stat(tokenPath).catch(() => null);
      if (!tokenStat) {
        throw new Error("Not running in a Kubernetes pod with service account");
      }

      const token = await Deno.readTextFile(tokenPath);
      const ca = await Deno.readTextFile(caPath).catch(() => undefined);

      return {
        server: "https://kubernetes.default.svc",
        token: token.trim(),
        ca,
        insecure: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load service account credentials: ${errorMessage}`,
      );
    }
  }

  /**
   * Create HTTP headers for authentication
   */
  static createAuthHeaders(config: K8sAuthConfig): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "atlas-k8s-watch/1.0.0",
    };

    if (config.token) {
      headers["Authorization"] = `Bearer ${config.token}`;
    }

    return headers;
  }

  /**
   * Get home directory (cross-platform)
   */
  private static getHomeDir(): string {
    // Try HOME first (Unix-like systems)
    const home = Deno.env.get("HOME");
    if (home) return home;

    // Try USERPROFILE (Windows)
    const userProfile = Deno.env.get("USERPROFILE");
    if (userProfile) return userProfile;

    throw new Error("Could not determine home directory");
  }

  /**
   * Get default kubeconfig path
   */
  private static getDefaultKubeconfigPath(): string {
    // Check KUBECONFIG environment variable first
    const kubeconfigEnv = Deno.env.get("KUBECONFIG");
    if (kubeconfigEnv) {
      return kubeconfigEnv;
    }

    // Default to ~/.kube/config (cross-platform)
    return join(this.getHomeDir(), ".kube", "config");
  }

  /**
   * Parse kubeconfig and extract authentication info
   */
  private static async parseKubeconfig(
    kubeconfig: KubeconfigFile,
  ): Promise<K8sAuthConfig> {
    if (!kubeconfig.contexts || !kubeconfig.clusters || !kubeconfig.users) {
      throw new Error(
        "Invalid kubeconfig: missing contexts, clusters, or users",
      );
    }

    // Find current context
    const currentContextName = kubeconfig["current-context"];
    if (!currentContextName) {
      throw new Error("No current-context set in kubeconfig");
    }

    const currentContext = kubeconfig.contexts.find(
      (ctx) => ctx.name === currentContextName,
    );
    if (!currentContext) {
      throw new Error(
        `Current context '${currentContextName}' not found in kubeconfig`,
      );
    }

    // Find cluster
    const cluster = kubeconfig.clusters.find(
      (c) => c.name === currentContext.context.cluster,
    );
    if (!cluster) {
      throw new Error(
        `Cluster '${currentContext.context.cluster}' not found in kubeconfig`,
      );
    }

    // Find user
    const user = kubeconfig.users.find(
      (u) => u.name === currentContext.context.user,
    );
    if (!user) {
      throw new Error(
        `User '${currentContext.context.user}' not found in kubeconfig`,
      );
    }

    // Build auth config
    const authConfig: K8sAuthConfig = {
      server: cluster.cluster.server,
      insecure: cluster.cluster["insecure-skip-tls-verify"] || false,
    };

    // Handle CA certificate
    if (cluster.cluster["certificate-authority-data"]) {
      // SECURITY FIX: Validate base64 data before decoding
      try {
        const caData = cluster.cluster["certificate-authority-data"];
        if (!caData || typeof caData !== "string") {
          throw new Error("Invalid CA certificate data");
        }
        authConfig.ca = atob(caData);
        // Validate that decoded content looks like a certificate
        if (!authConfig.ca.includes("-----BEGIN CERTIFICATE-----")) {
          throw new Error("Invalid CA certificate format");
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid CA certificate data: ${errorMessage}`);
      }
    } else if (cluster.cluster["certificate-authority"]) {
      try {
        // SECURITY FIX: Use safe file reading
        authConfig.ca = await this.readCertificateFile(
          cluster.cluster["certificate-authority"],
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read CA certificate: ${errorMessage}`);
      }
    }

    // Handle user authentication
    if (user.user.token) {
      // SECURITY FIX: Validate token format
      if (typeof user.user.token !== "string" || user.user.token.length < 10) {
        throw new Error("Invalid token format");
      }
      authConfig.token = user.user.token;
    } else if (
      user.user["client-certificate-data"] &&
      user.user["client-key-data"]
    ) {
      // SECURITY FIX: Validate base64 certificate data
      try {
        const certData = user.user["client-certificate-data"];
        const keyData = user.user["client-key-data"];

        if (
          !certData ||
          !keyData ||
          typeof certData !== "string" ||
          typeof keyData !== "string"
        ) {
          throw new Error("Invalid client certificate data");
        }

        authConfig.cert = atob(certData);
        authConfig.key = atob(keyData);

        // Validate certificate format
        if (!authConfig.cert.includes("-----BEGIN CERTIFICATE-----")) {
          throw new Error("Invalid client certificate format");
        }
        if (
          !authConfig.key.includes("-----BEGIN") ||
          !authConfig.key.includes("PRIVATE KEY-----")
        ) {
          throw new Error("Invalid client key format");
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid client certificate data: ${errorMessage}`);
      }
    } else if (user.user["client-certificate"] && user.user["client-key"]) {
      try {
        // SECURITY FIX: Use safe file reading
        authConfig.cert = await this.readCertificateFile(
          user.user["client-certificate"],
        );
        authConfig.key = await this.readCertificateFile(
          user.user["client-key"],
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read client certificates: ${errorMessage}`);
      }
    } else if (user.user.exec) {
      // Handle exec authentication (e.g., kubectl plugins)
      authConfig.token = await this.executeAuthCommand(user.user.exec);
    } else {
      throw new Error(
        "No supported authentication method found in kubeconfig user",
      );
    }

    return authConfig;
  }

  /**
   * Execute authentication command (e.g., kubectl plugins)
   * SECURITY: Only allow whitelisted commands to prevent command injection
   */
  private static async executeAuthCommand(exec: {
    command: string;
    args?: string[];
    env?: Array<{ name: string; value: string }>;
  }): Promise<string> {
    // SECURITY FIX: Whitelist allowed authentication commands
    const allowedCommands = [
      "kubectl",
      "gcloud",
      "aws",
      "azure",
      "oc", // OpenShift CLI
    ];

    const baseCommand = exec.command.split("/").pop()?.split("\\").pop(); // Extract just the command name
    if (!baseCommand || !allowedCommands.includes(baseCommand)) {
      throw new Error(
        `Unauthorized authentication command: ${exec.command}. Only allowed: ${
          allowedCommands.join(", ")
        }`,
      );
    }

    // SECURITY FIX: Validate and sanitize arguments
    if (exec.args) {
      for (const arg of exec.args) {
        if (typeof arg !== "string") {
          throw new Error("Invalid argument type in auth command");
        }
        // Prevent argument injection
        if (
          arg.includes(";") ||
          arg.includes("&") ||
          arg.includes("|") ||
          arg.includes("`")
        ) {
          throw new Error("Invalid characters in auth command arguments");
        }
      }
    }

    // SECURITY FIX: Validate environment variables
    const env: Record<string, string> = {};
    if (exec.env) {
      for (const envVar of exec.env) {
        if (
          typeof envVar.name !== "string" ||
          typeof envVar.value !== "string"
        ) {
          throw new Error("Invalid environment variable type in auth command");
        }
        // Only allow safe environment variable names
        if (!/^[A-Z_][A-Z0-9_]*$/i.test(envVar.name)) {
          throw new Error(`Invalid environment variable name: ${envVar.name}`);
        }
        env[envVar.name] = envVar.value;
      }
    }

    try {
      // Execute command with timeout
      const cmd = new Deno.Command(exec.command, {
        args: exec.args || [],
        env: { ...env }, // Only use sanitized env vars, not system env
        stdout: "piped",
        stderr: "piped",
      });

      // Add timeout to prevent hanging
      const timeoutMs = 30000; // 30 seconds
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Auth command timeout")), timeoutMs)
      );

      const { code, stdout, stderr } = await Promise.race([
        cmd.output(),
        timeoutPromise,
      ]);

      if (code !== 0) {
        const _errorOutput = new TextDecoder().decode(stderr);
        // SECURITY FIX: Don't expose full error output, it might contain sensitive info
        throw new Error(`Auth command failed with code ${code}`);
      }

      // Parse the exec output to extract token
      const output = new TextDecoder().decode(stdout);
      let result;
      try {
        result = JSON.parse(output);
      } catch {
        throw new Error("Auth command returned invalid JSON");
      }

      if (result?.status?.token && typeof result.status.token === "string") {
        return result.status.token;
      } else {
        throw new Error("Auth command did not return a valid token");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to execute auth command: ${errorMessage}`);
    }
  }
}
