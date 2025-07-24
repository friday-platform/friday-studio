import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { join } from "@std/path";

interface WebSession {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdAt: Date;
  lastUsed: Date;
}

export class WebSessionManager {
  private sessions = new Map<string, WebSession>();
  private cleanupInterval: number | null = null;
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  private isStarted = false;

  constructor() {
    // Don't start the cleanup interval in constructor
    // This prevents the timer from being created on import
  }

  // Start the cleanup interval only when needed
  private ensureStarted() {
    if (!this.isStarted) {
      this.isStarted = true;
      // Clean up expired sessions every 5 minutes
      this.cleanupInterval = setInterval(() => {
        this.cleanupExpiredSessions();
      }, 5 * 60 * 1000);
    }
  }

  async createSession(sessionId: string, options: {
    userAgent?: string;
    viewport?: { width: number; height: number };
    locale?: string;
  } = {}): Promise<WebSession> {
    // Ensure the cleanup timer is started
    this.ensureStarted();

    // Clean up existing session if it exists
    await this.closeSession(sessionId);

    const bundledBrowserPath = this.getBundledBrowserPath();
    let executablePath: string | undefined;

    if (bundledBrowserPath) {
      executablePath = this.getChromiumExecutablePath(bundledBrowserPath);
    }

    const browser = await chromium.launch({
      headless: true,
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ],
    });

    const context = await browser.newContext({
      userAgent: options.userAgent ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: options.viewport || { width: 1920, height: 1080 },
      locale: options.locale || "en-US",
      acceptDownloads: false,
      bypassCSP: true,
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();

    // Set reasonable timeouts
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    const session: WebSession = {
      id: sessionId,
      browser,
      context,
      page,
      createdAt: new Date(),
      lastUsed: new Date(),
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): WebSession | null {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastUsed = new Date();
      return session;
    }
    return null;
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        await session.browser.close();
      } catch (error) {
        console.error(`Error closing session ${sessionId}:`, error);
      }
      this.sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  async closeAllSessions(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map((id) => this.closeSession(id)));
  }

  listSessions(): Array<{ id: string; createdAt: Date; lastUsed: Date }> {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      lastUsed: session.lastUsed,
    }));
  }

  private cleanupExpiredSessions(): void {
    const now = new Date();
    const expiredSessions: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      if (now.getTime() - session.lastUsed.getTime() > this.SESSION_TIMEOUT) {
        expiredSessions.push(sessionId);
      }
    }

    expiredSessions.forEach((sessionId) => {
      this.closeSession(sessionId);
    });
  }

  private getBundledBrowserPath(): string | undefined {
    const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";

    if (!homeDir) {
      return undefined;
    }

    const possiblePaths = [
      join(homeDir, ".atlas", "browsers"),
      Deno.env.get("PLAYWRIGHT_BROWSERS_PATH"),
      "/usr/share/atlas/browsers",
      "/usr/local/share/atlas/browsers",
    ];

    for (const path of possiblePaths) {
      if (path && this.existsSync(path)) {
        return path;
      }
    }

    return undefined;
  }

  private getChromiumExecutablePath(browsersPath: string): string | undefined {
    const platform = Deno.build.os;

    let chromiumDir: string | undefined;
    try {
      for (const entry of Deno.readDirSync(browsersPath)) {
        if (entry.isDirectory && entry.name.startsWith("chromium-")) {
          chromiumDir = join(browsersPath, entry.name);
          break;
        }
      }
    } catch {
      return undefined;
    }

    if (!chromiumDir) {
      return undefined;
    }

    let executablePath: string;
    switch (platform) {
      case "darwin":
        executablePath = join(chromiumDir, "chrome-mac", "headless_shell");
        break;
      case "linux":
        executablePath = join(chromiumDir, "chrome-linux", "headless_shell");
        break;
      case "windows":
        executablePath = join(chromiumDir, "chrome-win", "headless_shell.exe");
        break;
      default:
        return undefined;
    }

    return this.existsSync(executablePath) ? executablePath : undefined;
  }

  private existsSync(path: string): boolean {
    try {
      Deno.statSync(path);
      return true;
    } catch {
      return false;
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.closeAllSessions();
  }
}

// Global session manager instance
export const webSessionManager = new WebSessionManager();
