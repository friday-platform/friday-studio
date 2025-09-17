/**
 * Centralized configuration for the installer
 */

export const CONFIG = {
  // Process management
  process: {
    defaultTimeout: 10000,
    stopTimeout: 10000,
    startTimeout: 30000,
    installTimeout: 30000,
    statusCheckTimeout: 5000,
    killTimeout: 5000,
    retryDelay: 1000,
    maxRetries: 10,
  },

  // Installation paths
  paths: {
    windows: {
      installDir: "AppData\\Local\\Atlas",
      binaryName: "atlas.exe",
      diagnosticsName: "atlas-diagnostics.exe",
      webAppName: "atlas-web-app.exe",
    },
    macos: {
      installDir: "/usr/local/bin",
      userBinDir: ".atlas/bin",
      binaryName: "atlas",
      diagnosticsName: "atlas-diagnostics",
      webAppName: "Atlas Web Client.app",
      plistPath: "Library/LaunchAgents/com.tempestdx.atlas.plist",
    },
  },

  // Service configuration
  service: { defaultPort: 8080, taskName: "AtlasDaemon", serviceLabel: "com.tempestdx.atlas" },

  // Application names
  apps: { macWebClient: "Atlas Web Client.app" },

  // Security
  security: {
    maxPathLength: 4096,
    allowedBinaryNames: [
      "atlas",
      "atlas.exe",
      "atlas-diagnostics",
      "atlas-diagnostics.exe",
      "atlas-web-app",
      "atlas-web-app.exe",
    ],
    jwtClockSkewTolerance: 300, // 5 minutes
  },

  // UI
  ui: { windowWidth: 950, windowHeight: 850, minWindowWidth: 600, minWindowHeight: 400 },
} as const;
