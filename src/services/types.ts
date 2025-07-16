export interface ServiceConfig {
  /** Port for Atlas daemon to listen on */
  port: number;
  /** Whether to start service automatically after installation */
  autoStart: boolean;
  /** Custom service name (defaults to platform-specific name) */
  serviceName?: string;
  /** Additional environment variables for the service */
  environment?: Record<string, string>;
  /** Custom working directory for the service */
  workingDirectory?: string;
}

export interface ServiceStatus {
  /** Whether the service is currently running */
  running: boolean;
  /** Current platform (macos, linux, windows) */
  platform: string;
  /** Name of the service */
  serviceName: string;
  /** Process ID if running */
  pid?: number;
  /** Port the service is listening on */
  port?: number;
  /** Service uptime string */
  uptime?: string;
  /** Error message if service is in error state */
  error?: string;
  /** Whether service is installed */
  installed?: boolean;
}

export interface PlatformServiceManager {
  /** Install the service with given configuration */
  install(config: ServiceConfig): Promise<void>;

  /** Uninstall the service */
  uninstall(): Promise<void>;

  /** Start the service */
  start(): Promise<void>;

  /** Stop the service */
  stop(force?: boolean): Promise<void>;

  /** Get current service status */
  getStatus(): Promise<ServiceStatus>;

  /** Check if service is installed */
  isInstalled(): Promise<boolean>;
}

export type Platform = "macos" | "linux" | "windows" | "unknown";

export interface LaunchAgentConfig {
  Label: string;
  ProgramArguments: string[];
  WorkingDirectory?: string;
  EnvironmentVariables?: Record<string, string>;
  RunAtLoad: boolean;
  KeepAlive: boolean | { SuccessfulExit?: boolean };
  StandardOutPath?: string;
  StandardErrorPath?: string;
}

export interface SystemdServiceConfig {
  Unit: {
    Description: string;
    After?: string[];
  };
  Service: {
    Type: string;
    ExecStart: string;
    WorkingDirectory?: string;
    Environment?: string[];
    Restart: string;
    RestartSec?: number;
  };
  Install: {
    WantedBy: string[];
  };
}

export interface WindowsServiceConfig {
  serviceName: string;
  displayName: string;
  description: string;
  executable: string;
  arguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
}
