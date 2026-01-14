import process from "node:process";
import { createLogger } from "@atlas/logger";
import { importPKCS8, SignJWT } from "jose";

const logger = createLogger({ name: "cortex-test-server" });

/**
 * Manages Cortex service lifecycle for testing.
 * Spawns Cortex as a subprocess using `go run`, waits for readiness,
 * and handles graceful shutdown with SIGTERM.
 */
export class CortexTestServer {
  private process: Deno.ChildProcess | null = null;
  private jwtPublicKeyPath: string | null = null;
  private jwtPrivateKey: string | null = null;
  public readonly url: string;
  public readonly port: number;
  public readonly userId: string;
  public authToken!: string; // Set after JWT key generation

  constructor(port = 8181) {
    this.port = port;
    this.url = `http://localhost:${port}`;
    this.userId = `test-user-${crypto.randomUUID()}`;
  }

  async start(): Promise<void> {
    logger.info("Starting Cortex test server", { port: this.port });

    // Generate temporary JWT key for testing
    await this.generateJWTKey();

    // Generate JWT token with user ID
    await this.generateAuthToken();

    const cortexDir = "apps/cortex";

    const command = new Deno.Command("go", {
      args: ["run", "main.go"],
      cwd: cortexDir,
      env: {
        ...process.env,
        PORT: String(this.port),
        POSTGRES_CONNECTION: this.getDatabaseUrl(),
        // Use STORAGE_EMULATOR_HOST for Go GCS SDK to connect to mock
        // This automatically disables auth and uses the mock server
        STORAGE_EMULATOR_HOST: "localhost:4443",
        GCS_BUCKET: "test-bucket", // Mock bucket name
        JWT_PUBLIC_KEY_FILE: this.jwtPublicKeyPath ?? "",
        LOG_LEVEL: "error", // Reduce noise in tests
      },
      stdout: "inherit",
      stderr: "inherit",
    });

    this.process = command.spawn();

    // Capture output for debugging
    this.captureOutput();

    // Wait for service to be ready
    try {
      await this.waitForReady();
      logger.info("Cortex test server started", { url: this.url, userId: this.userId });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    logger.info("Stopping Cortex test server");

    try {
      // Kill the actual Go binary process using the port it's listening on
      // This is more reliable than killing the 'go run' parent process
      await this.killProcessByPort(this.port);

      // Also kill the parent 'go run' process
      try {
        this.process.kill("SIGTERM");
        await this.process.status;
      } catch {
        // Process might already be dead, ignore
      }

      logger.info("Cortex test server stopped");
    } catch (error) {
      logger.error("Error stopping Cortex", { error });
    } finally {
      this.process = null;
    }

    // Clean up JWT public key file
    if (this.jwtPublicKeyPath) {
      try {
        await Deno.remove(this.jwtPublicKeyPath);
        logger.debug("Cleaned up JWT key file", { path: this.jwtPublicKeyPath });
      } catch (error) {
        logger.warn("Failed to clean up JWT key file", { error });
      }
      this.jwtPublicKeyPath = null;
      this.jwtPrivateKey = null;
    }
  }

  /**
   * Kill the process listening on the specified port.
   * Uses lsof to find the PID and sends SIGTERM for graceful shutdown.
   */
  private async killProcessByPort(port: number): Promise<void> {
    try {
      // Find PID using lsof
      const lsofCmd = new Deno.Command("lsof", {
        args: ["-ti", `:${port}`],
        stdout: "piped",
        stderr: "piped",
      });

      const lsofResult = await lsofCmd.output();
      if (!lsofResult.success) {
        logger.debug("No process found on port", { port });
        return;
      }

      const decoder = new TextDecoder();
      const pidStr = decoder.decode(lsofResult.stdout).trim();
      if (!pidStr) {
        logger.debug("No PID found for port", { port });
        return;
      }

      const pid = parseInt(pidStr, 10);
      if (Number.isNaN(pid)) {
        logger.warn("Invalid PID from lsof", { pidStr });
        return;
      }

      logger.debug("Found process on port, sending SIGTERM", { port, pid });

      // Send SIGTERM for graceful shutdown
      const killCmd = new Deno.Command("kill", {
        args: ["-TERM", String(pid)],
        stdout: "piped",
        stderr: "piped",
      });

      await killCmd.output();

      // Wait for process to die (with timeout)
      const maxWait = 5000; // 5 seconds
      const startTime = Date.now();
      while (Date.now() - startTime < maxWait) {
        // Check if process is still running
        const checkCmd = new Deno.Command("lsof", {
          args: ["-ti", `:${port}`],
          stdout: "piped",
          stderr: "piped",
        });

        const checkResult = await checkCmd.output();
        if (!checkResult.success || !decoder.decode(checkResult.stdout).trim()) {
          logger.debug("Process stopped", { port, pid });
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // If still running after timeout, send SIGKILL
      logger.warn("Process didn't stop gracefully, sending SIGKILL", { port, pid });
      const killForceCmd = new Deno.Command("kill", {
        args: ["-KILL", String(pid)],
        stdout: "piped",
        stderr: "piped",
      });

      await killForceCmd.output();
      logger.debug("Sent SIGKILL", { port, pid });
    } catch (error) {
      logger.warn("Error killing process by port", { port, error });
    }
  }

  private getDatabaseUrl(): string {
    // Check for explicit test database URL
    const testDbUrl = process.env.CORTEX_TEST_DATABASE_URL;
    if (testDbUrl) {
      return testDbUrl;
    }

    // Default: local PostgreSQL with cortex_test database
    // Assumes: createdb cortex_test (one-time setup)
    return "postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable";
  }

  private async generateJWTKey(): Promise<void> {
    // Generate a temporary RSA key pair for testing
    const tempFile = await Deno.makeTempFile({ prefix: "cortex-jwt-pub-", suffix: ".pem" });

    try {
      // Generate RSA key pair using openssl
      const genPrivateKey = new Deno.Command("openssl", {
        args: ["genrsa", "-out", "/dev/stdout", "2048"],
        stdout: "piped",
        stderr: "piped",
      });

      const privateKeyResult = await genPrivateKey.output();
      if (!privateKeyResult.success) {
        throw new Error("Failed to generate RSA private key");
      }

      // Store private key for JWT signing
      const decoder = new TextDecoder();
      this.jwtPrivateKey = decoder.decode(privateKeyResult.stdout);

      // Extract public key from private key
      const genPublicKey = new Deno.Command("openssl", {
        args: ["rsa", "-pubout"],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });

      const publicKeyProcess = genPublicKey.spawn();
      const writer = publicKeyProcess.stdin.getWriter();
      await writer.write(privateKeyResult.stdout);
      await writer.close();

      const publicKeyResult = await publicKeyProcess.output();
      if (!publicKeyResult.success) {
        throw new Error("Failed to extract RSA public key");
      }

      // Write public key to temp file (for Cortex to read)
      await Deno.writeFile(tempFile, publicKeyResult.stdout);

      this.jwtPublicKeyPath = tempFile;
      logger.debug("Generated JWT key pair", { publicKeyPath: tempFile });
    } catch (error) {
      // Clean up temp file on error
      try {
        await Deno.remove(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  private async generateAuthToken(): Promise<void> {
    if (!this.jwtPrivateKey) {
      throw new Error("JWT private key not generated");
    }

    try {
      // Import private key for signing
      const privateKey = await importPKCS8(this.jwtPrivateKey, "RS256");

      // Create JWT with user_metadata.tempest_user_id claim
      const jwt = await new SignJWT({ user_metadata: { tempest_user_id: this.userId } })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);

      this.authToken = jwt;
      logger.debug("Generated auth token", { userId: this.userId });
    } catch (error) {
      throw new Error(`Failed to generate auth token: ${error}`);
    }
  }

  private async waitForReady(maxAttempts = 30, intervalMs = 1000): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 500);

        const response = await fetch(`${this.url}/health`, { signal: controller.signal });

        clearTimeout(timeoutId);

        if (response.ok) {
          await response.text(); // Consume body to prevent resource leak
          return;
        }
        await response.text(); // Consume body even if not ok
      } catch {
        // Service not ready yet, retry
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `Cortex service did not become ready after ${maxAttempts} attempts. Check logs above.`,
    );
  }

  async reset(): Promise<void> {
    // Try to reset via API endpoint if available
    try {
      const response = await fetch(`${this.url}/admin/reset`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.authToken}` },
      });
      if (response.ok) {
        await response.text(); // Consume body to prevent resource leak
        logger.debug("Cortex database reset via API");
        return;
      }
      await response.text(); // Consume body even if not ok
    } catch {
      // Endpoint might not exist, try direct database approach
    }

    // Direct database truncation as fallback
    // This requires psql to be available
    try {
      const command = new Deno.Command("psql", {
        args: [this.getDatabaseUrl(), "-c", "TRUNCATE TABLE objects, metadata CASCADE;"],
        stdout: "piped",
        stderr: "piped",
      });

      const { code } = await command.output();
      if (code === 0) {
        logger.debug("Cortex database reset via psql");
        return;
      }
    } catch (error) {
      logger.warn("Failed to reset Cortex database", { error });
    }

    logger.warn("No reset method available, tests may have stale data");
  }

  private captureOutput(): void {
    if (!this.process) return;

    // Capture stdout
    (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of this.process?.stdout ?? []) {
          const text = decoder.decode(chunk);
          if (text.trim()) {
            logger.debug("cortex stdout", { stdout: text.trim() });
          }
        }
      } catch {
        // Stream closed
      }
    })();

    // Capture stderr
    (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of this.process?.stderr ?? []) {
          const text = decoder.decode(chunk);
          if (text.trim()) {
            logger.warn("cortex stderr", { stderr: text.trim() });
          }
        }
      } catch {
        // Stream closed
      }
    })();
  }
}
