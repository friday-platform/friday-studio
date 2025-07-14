const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const process = require("process");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 750,
    resizable: false,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Load the installer interface
  mainWindow.loadFile("index.html");

  // Hide menu bar
  mainWindow.setMenuBarVisibility(false);

  // Open DevTools in development
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers for installation
ipcMain.handle("get-platform", () => {
  return {
    platform: process.platform,
    arch: process.arch,
    homedir: os.homedir(),
  };
});

ipcMain.handle("create-atlas-dir", async () => {
  try {
    const atlasDir = path.join(os.homedir(), ".atlas");
    if (!fs.existsSync(atlasDir)) {
      fs.mkdirSync(atlasDir, { recursive: true });
    }
    return { success: true, path: atlasDir };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("save-api-key", async (event, apiKey) => {
  try {
    // Validate API key format on backend too
    const apiKeyPattern = /^sk-ant-[a-z0-9]+-[A-Za-z0-9_-]+$/;
    if (!apiKey || !apiKeyPattern.test(apiKey)) {
      return { success: false, error: "Invalid API key format" };
    }

    const atlasDir = path.join(os.homedir(), ".atlas");
    const envFile = path.join(atlasDir, ".env");

    // Ensure .atlas directory exists
    if (!fs.existsSync(atlasDir)) {
      fs.mkdirSync(atlasDir, { recursive: true });
    }

    const envContent = `ANTHROPIC_API_KEY=${apiKey}\n`;
    fs.writeFileSync(envFile, envContent, "utf8");

    // Set file permissions (Unix-like systems)
    if (process.platform !== "win32") {
      fs.chmodSync(envFile, 0o600);
    }

    return { success: true, path: envFile };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("install-atlas-binary", async () => {
  try {
    // In Electron, __dirname points to inside the asar archive
    // For unpacked files, we need to go to the app.asar.unpacked directory
    let binarySource;

    // First try the unpacked location (production)
    binarySource = path.join(path.dirname(__dirname), "app.asar.unpacked", "atlas-binary", "atlas");

    if (!fs.existsSync(binarySource)) {
      // Fallback to development location
      binarySource = path.join(__dirname, "atlas-binary", "atlas");
    }

    // Check if source binary exists
    if (!fs.existsSync(binarySource)) {
      return { success: false, error: "Atlas binary not found in installer package" };
    }

    // Determine installation path based on platform
    let installPath;
    if (process.platform === "win32") {
      // Windows: Install to Program Files
      installPath = path.join(
        process.env.ProgramFiles || "C:\\Program Files",
        "Atlas",
        "atlas.exe",
      );
      const installDir = path.dirname(installPath);

      // Create directory if it doesn't exist
      if (!fs.existsSync(installDir)) {
        fs.mkdirSync(installDir, { recursive: true });
      }

      // Copy binary with .exe extension
      fs.copyFileSync(binarySource, installPath);
    } else {
      // macOS/Linux: Install to /usr/local/bin
      installPath = "/usr/local/bin/atlas";

      // Use platform-specific privilege escalation
      if (process.platform === "darwin") {
        // macOS: Use osascript to request admin privileges (native macOS approach)
        const { execSync } = require("child_process");

        try {
          // Combine copy and chmod operations into a single privileged command to avoid dual password prompts
          execSync(
            `osascript -e 'do shell script "cp '"'"'${binarySource}'"'"' '"'"'${installPath}'"'"' && chmod 755 '"'"'${installPath}'"'"'" with administrator privileges'`,
          );
        } catch (execError) {
          // Provide more detailed error information
          return {
            success: false,
            error:
              `Installation failed: ${execError.message}. Binary source: ${binarySource}, Install path: ${installPath}`,
          };
        }
      } else {
        // Linux: Use pkexec instead of sudo for better GUI integration
        const { execSync } = require("child_process");

        try {
          // pkexec provides a GUI password prompt like macOS
          execSync(`pkexec cp "${binarySource}" "${installPath}"`);
          execSync(`pkexec chmod 755 "${installPath}"`);
        } catch (execError) {
          // Fallback to sudo if pkexec is not available
          try {
            execSync(`sudo cp "${binarySource}" "${installPath}"`);
            execSync(`sudo chmod 755 "${installPath}"`);
          } catch (sudoError) {
            return { success: false, error: `Failed to install: ${sudoError.message}` };
          }
        }
      }
    }

    // Verify the installation
    if (fs.existsSync(installPath)) {
      return { success: true, path: installPath, message: "Atlas binary installed successfully" };
    } else {
      return { success: false, error: "Binary installation failed - file not found after copy" };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Note: simulate-binary-install handler removed to avoid conflicts with install-atlas-binary

ipcMain.handle("setup-path", async () => {
  // In a real installer, this would:
  // - Windows: Update registry or environment variables
  // - macOS/Linux: Modify shell configuration files (.bashrc, .zshrc, etc.)

  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ success: true, message: "PATH setup simulated" });
    }, 500);
  });
});

ipcMain.handle("quit-app", () => {
  app.quit();
});
