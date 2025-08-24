import { detectPlatform, isPlatformSupported } from "../utils/platform.ts";
import { LinuxSystemdService } from "./platforms/linux-systemd.ts";
import { MacOSLaunchdService } from "./platforms/macos-launchd.ts";
import { WindowsService } from "./platforms/windows.ts";
import type { PlatformServiceManager, ServiceConfig, ServiceStatus } from "./types.ts";

export class ServiceManager implements PlatformServiceManager {
  private static instance: ServiceManager;
  private platformManager: PlatformServiceManager;

  private constructor() {
    const platform = detectPlatform();

    if (!isPlatformSupported()) {
      throw new Error(`Service management is not supported on platform: ${platform}`);
    }

    switch (platform) {
      case "macos":
        this.platformManager = new MacOSLaunchdService();
        break;
      case "linux":
        this.platformManager = new LinuxSystemdService();
        break;
      case "windows":
        this.platformManager = new WindowsService();
        break;
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  static getInstance(): ServiceManager {
    if (!ServiceManager.instance) {
      ServiceManager.instance = new ServiceManager();
    }
    return ServiceManager.instance;
  }

  async install(config: ServiceConfig): Promise<void> {
    return await this.platformManager.install(config);
  }

  async uninstall(): Promise<void> {
    return await this.platformManager.uninstall();
  }

  async start(): Promise<void> {
    return await this.platformManager.start();
  }

  async stop(force?: boolean): Promise<void> {
    return await this.platformManager.stop(force);
  }

  async getStatus(): Promise<ServiceStatus> {
    return await this.platformManager.getStatus();
  }

  async isInstalled(): Promise<boolean> {
    return await this.platformManager.isInstalled();
  }

  /**
   * Convenience method to restart the service
   */
  async restart(): Promise<void> {
    const status = await this.getStatus();

    if (status.running) {
      await this.stop();

      // Wait for service to stop
      let attempts = 0;
      while (attempts < 10) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const currentStatus = await this.getStatus();
        if (!currentStatus.running) {
          break;
        }
        attempts++;
      }
    }

    await this.start();
  }

  /**
   * Get the current platform
   */
  getPlatform(): string {
    return detectPlatform();
  }

  /**
   * Check if service management is supported on current platform
   */
  isSupported(): boolean {
    return isPlatformSupported();
  }
}
