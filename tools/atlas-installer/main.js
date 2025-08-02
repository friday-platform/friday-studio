const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 950,
    height: 850,
    resizable: true,
    minWidth: 600,
    minHeight: 400,
    title: "Atlas Installer",
    titleBarStyle: "hiddenInset",
    fullscreenable: false,
    maximizable: false,
    ...(process.platform !== "darwin" ? { titleBarOverlay: true } : {}),
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

ipcMain.handle("check-existing-api-key", async () => {
  try {
    const atlasDir = path.join(os.homedir(), ".atlas");
    const envFile = path.join(atlasDir, ".env");

    if (!fs.existsSync(envFile)) {
      return { exists: false };
    }

    const envContent = fs.readFileSync(envFile, "utf8");
    const hasAtlasKey = envContent.includes("ATLAS_KEY=") &&
      envContent.match(
        /ATLAS_KEY=eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
      );

    return { exists: !!hasAtlasKey };
  } catch (error) {
    return { exists: false, error: error.message };
  }
});

// IPC handler for saving Atlas Access Key to .env file
ipcMain.handle("save-atlas-key", async (event, atlasKey) => {
  try {
    const atlasDir = path.join(os.homedir(), ".atlas");
    const envFile = path.join(atlasDir, ".env");

    // Ensure .atlas directory exists
    if (!fs.existsSync(atlasDir)) {
      fs.mkdirSync(atlasDir, { recursive: true });
    }

    let envContent = "";
    let existingLines = [];

    // Read existing .env file if it exists
    if (fs.existsSync(envFile)) {
      const existingContent = fs.readFileSync(envFile, "utf8");
      existingLines = existingContent.split("\n");
    }

    // Filter out any existing ATLAS_KEY line
    const filteredLines = existingLines.filter(
      (line) => !line.trim().startsWith("ATLAS_KEY="),
    );

    // Add the new ATLAS_KEY
    filteredLines.push(`ATLAS_KEY=${atlasKey}`);

    // Join lines and ensure file ends with newline
    envContent = filteredLines.filter((line) => line.trim()).join("\n") + "\n";

    // Write the updated .env file
    fs.writeFileSync(envFile, envContent, "utf8");

    // Set file permissions (Unix-like systems)
    if (process.platform !== "win32") {
      fs.chmodSync(envFile, 0o600);
    }

    return {
      success: true,
      path: envFile,
      message: "Atlas Access Key saved successfully",
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("install-atlas-binary", async () => {
  try {
    // In Electron, resource locations vary by platform and packaging
    let binarySource;
    const binaryName = process.platform === "win32" ? "atlas.exe" : "atlas";

    // Windows/macOS: Try standard locations
    // First try the unpacked location (production)
    // When packaged with asar, __dirname is inside the asar file, so we need to
    // get the actual Resources directory path
    const resourcesPath = process.resourcesPath || path.dirname(path.dirname(__dirname));
    binarySource = path.join(
      resourcesPath,
      "app.asar.unpacked",
      "atlas-binary",
      binaryName,
    );

    if (!fs.existsSync(binarySource)) {
      // Fallback to development location
      binarySource = path.join(__dirname, "atlas-binary", binaryName);
    }

    // Check if source binary exists
    if (!binarySource || !fs.existsSync(binarySource)) {
      return {
        success: false,
        error: "Atlas binary not found in installer package",
      };
    }

    // Determine installation path based on platform
    let installPath;
    if (process.platform === "win32") {
      // Windows: Install to user's local app data to avoid admin permissions
      const userProfile = process.env.USERPROFILE || process.env.HOME || "C:\\Users\\Default";
      installPath = path.join(
        userProfile,
        "AppData",
        "Local",
        "Atlas",
        "atlas.exe",
      );
      const installDir = path.dirname(installPath);

      // Create directory if it doesn't exist
      if (!fs.existsSync(installDir)) {
        fs.mkdirSync(installDir, { recursive: true });
      }

      // Handle existing binary - stop daemon if running and overwrite
      if (fs.existsSync(installPath)) {
        try {
          // Try to stop the daemon gracefully first
          const { execSync } = require("child_process");
          try {
            execSync(`"${installPath}" daemon stop`, {
              timeout: 5000,
              stdio: "ignore",
            });
          } catch {
            // If daemon stop fails, force kill atlas processes
            try {
              execSync("taskkill /F /IM atlas.exe", {
                timeout: 5000,
                stdio: "ignore",
              });
            } catch {
              // Ignore if no processes to kill
            }
          }

          // Wait a moment for processes to terminate
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch {
          // Continue with installation even if stop fails
        }
      }

      // Copy binary with .exe extension (overwrite existing)
      fs.copyFileSync(binarySource, installPath);

      // Immediately update PATH for Windows
      const { execSync } = require("child_process");
      try {
        const psCommand = `
          $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
          if ($userPath -notlike "*${installDir}*") {
            [Environment]::SetEnvironmentVariable('Path', $userPath + ';${installDir}', 'User')
          }
        `.trim();

        execSync(`powershell -Command "${psCommand}"`, {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        // PATH update failed silently
      }
    } else {
      // macOS/Linux: Use symlink-based installation
      const userBinaryPath = path.join(os.homedir(), ".atlas", "bin", "atlas");
      const systemBinaryPath = "/usr/local/bin/atlas";

      // Use platform-specific privilege escalation
      if (process.platform === "darwin") {
        // macOS: Use osascript to request admin privileges (native macOS approach)
        const { execSync } = require("child_process");

        try {
          // First, create .atlas/bin directory and copy binary there (no admin needed)
          const userBinDir = path.dirname(userBinaryPath);
          if (!fs.existsSync(userBinDir)) {
            fs.mkdirSync(userBinDir, { recursive: true });
          }

          // Copy binary to user location
          fs.copyFileSync(binarySource, userBinaryPath);
          fs.chmodSync(userBinaryPath, 0o755);

          // Check if there's an existing installation
          let existingIsSymlink = false;
          let existingTarget = null;

          try {
            const stats = fs.lstatSync(systemBinaryPath);
            if (stats.isSymbolicLink()) {
              existingIsSymlink = true;
              existingTarget = fs.readlinkSync(systemBinaryPath);
            }
          } catch {
            // No existing installation
          }

          // Prepare the installation command based on existing setup
          let installCommand;
          if (existingIsSymlink) {
            // If already a symlink, just update the target (might not need sudo)
            installCommand = `ln -sf ${userBinaryPath} ${systemBinaryPath}`;
          } else if (fs.existsSync(systemBinaryPath)) {
            // If direct binary exists, replace with symlink
            installCommand =
              `rm -f ${systemBinaryPath} && ln -sf ${userBinaryPath} ${systemBinaryPath}`;
          } else {
            // Fresh installation
            installCommand = `ln -sf ${userBinaryPath} ${systemBinaryPath}`;
          }

          // Execute with admin privileges using proper escaping
          const script =
            `do shell script "${installCommand}" with administrator privileges with prompt "Atlas Installer needs administrator access to create a symlink in /usr/local/bin/"`;
          execSync(`osascript -e '${script}'`);

          // Update installPath to reflect the actual binary location
          installPath = userBinaryPath;
        } catch (execError) {
          // Provide more detailed error information
          return {
            success: false,
            error:
              `Installation failed: ${execError.message}. Binary source: ${binarySource}, User path: ${userBinaryPath}`,
          };
        }
      } else {
        // Unsupported platform
        return {
          success: false,
          error: `Unsupported platform: ${process.platform}`,
        };
      }
    }

    // Verify the installation
    if (fs.existsSync(installPath)) {
      return {
        success: true,
        path: installPath,
        message: "Atlas binary installed successfully",
      };
    } else {
      return {
        success: false,
        error: "Binary installation failed - file not found after copy",
      };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Note: simulate-binary-install handler removed to avoid conflicts with install-atlas-binary

ipcMain.handle("setup-path", async () => {
  try {
    if (process.platform === "win32") {
      // For Windows, we'll create a Start Menu shortcut instead of modifying PATH
      const { execSync } = require("child_process");
      const fs = require("fs");
      const userProfile = process.env.USERPROFILE || process.env.HOME || "C:\\Users\\Default";
      const atlasDir = path.join(userProfile, "AppData", "Local", "Atlas");
      const binaryPath = path.join(atlasDir, "atlas.exe");

      try {
        // Create Start Menu shortcut for Atlas
        const startMenuPath = path.join(
          userProfile,
          "AppData",
          "Roaming",
          "Microsoft",
          "Windows",
          "Start Menu",
          "Programs",
        );

        // Create a proper Windows shortcut using PowerShell
        const createShortcutPS = `
          $WshShell = New-Object -ComObject WScript.Shell
          $Shortcut = $WshShell.CreateShortcut('${startMenuPath}\\Atlas.lnk')
          $Shortcut.TargetPath = '${binaryPath}'
          $Shortcut.WorkingDirectory = '${userProfile}'
          $Shortcut.IconLocation = '${binaryPath},0'
          $Shortcut.Description = 'Atlas AI Development Assistant'
          $Shortcut.Save()
        `
          .trim()
          .replace(/\n\s*/g, "; ");

        try {
          execSync(`powershell -Command "${createShortcutPS}"`, {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {
          // Fallback to batch file if PowerShell fails
          const atlasShortcut = `@echo off\nstart "" "${binaryPath}"`;
          fs.writeFileSync(
            path.join(startMenuPath, "Atlas.bat"),
            atlasShortcut,
          );
        }

        // Try to update PATH using PowerShell (more reliable than setx)
        try {
          const psCommand = `
            $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            if ($userPath -notlike "*${atlasDir}*") {
              [Environment]::SetEnvironmentVariable('Path', $userPath + ';${atlasDir}', 'User')
              $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
            }
          `.trim();

          execSync(`powershell -Command "${psCommand}"`, {
            windowsHide: true,
            stdio: "ignore",
          });

          // Also update PATH for current process and all child processes
          // This ensures immediate availability in new terminals
          const currentPath = process.env.PATH || "";
          if (!currentPath.includes(atlasDir)) {
            process.env.PATH = `${currentPath};${atlasDir}`;
          }

          // Force Windows to broadcast WM_SETTINGCHANGE to notify all applications
          // about the PATH change
          try {
            execSync(
              `powershell -Command "[System.Environment]::SetEnvironmentVariable('Path', [System.Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"`,
              { windowsHide: true, stdio: "ignore" },
            );
          } catch {
            // Broadcast might fail but PATH is still updated
          }
        } catch {
          // PATH update failed, but we have Start Menu shortcut
        }

        return {
          success: true,
          message:
            `Atlas has been added to your PATH and Start Menu.\n\nYou can now use 'atlas' from any new command prompt or PowerShell window.\n\nNote: If 'atlas' is not recognized in existing terminals, please close and reopen them.`,
        };
      } catch (error) {
        return {
          success: true,
          message: `Setup completed. Atlas installed at ${atlasDir}`,
        };
      }
    } else {
      // macOS/Linux: PATH setup not needed for /usr/local/bin
      return {
        success: true,
        message: "PATH setup not required (/usr/local/bin is in default PATH)",
      };
    }
  } catch (error) {
    return { success: false, error: `Setup failed: ${error.message}` };
  }
});

// Utility functions for daemon management
function getAtlasBinaryPath() {
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE || process.env.HOME || "C:\\Users\\Default";
    return path.join(userProfile, "AppData", "Local", "Atlas", "atlas.exe");
  } else {
    return "/usr/local/bin/atlas";
  }
}

function getAtlasEnv() {
  try {
    const atlasDir = path.join(os.homedir(), ".atlas");
    const envFile = path.join(atlasDir, ".env");

    if (!fs.existsSync(envFile)) return {};

    const envContent = fs.readFileSync(envFile, "utf8");
    const env = {};
    envContent.split("\n").forEach((line) => {
      const [key, ...valueParts] = line.split("=");
      if (key && valueParts.length > 0) {
        env[key.trim()] = valueParts.join("=").trim();
      }
    });
    return env;
  } catch {
    return {};
  }
}

// Check if Atlas binary exists and is accessible
ipcMain.handle("check-atlas-binary", async () => {
  try {
    const binaryPath = getAtlasBinaryPath();

    // Check if binary exists
    if (!fs.existsSync(binaryPath)) {
      return {
        exists: false,
        error: `Binary not found at ${binaryPath}`,
      };
    }

    // Check if binary is accessible (especially important on Unix systems)
    try {
      fs.accessSync(binaryPath, fs.constants.F_OK | fs.constants.R_OK);

      // On Windows, also check if it's executable
      if (process.platform === "win32") {
        // Try to get basic info about the file
        const stats = fs.statSync(binaryPath);
        if (!stats.isFile()) {
          return {
            exists: false,
            error: `Path exists but is not a file: ${binaryPath}`,
          };
        }
      } else {
        // On Unix, check execute permissions
        fs.accessSync(binaryPath, fs.constants.X_OK);
      }
    } catch (accessError) {
      return {
        exists: false,
        error: `Binary not accessible: ${accessError.message}`,
      };
    }

    return {
      exists: true,
      path: binaryPath,
    };
  } catch (error) {
    return {
      exists: false,
      error: `Failed to check binary: ${error.message}`,
    };
  }
});

// Check Atlas daemon status
ipcMain.handle("check-daemon-status", async () => {
  try {
    const { execSync } = require("child_process");
    const binaryPath = getAtlasBinaryPath();

    // Check if binary exists first
    if (!fs.existsSync(binaryPath)) {
      return {
        success: false,
        error: `Atlas binary not found at ${binaryPath}. Binary installation may have failed.`,
      };
    }

    // Verify binary is executable (especially important on Unix systems)
    try {
      fs.accessSync(binaryPath, fs.constants.F_OK | fs.constants.X_OK);
    } catch (accessError) {
      return {
        success: false,
        error: `Atlas binary at ${binaryPath} is not executable: ${accessError.message}`,
      };
    }

    const result = execSync(`"${binaryPath}" daemon status --json`, {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, ...getAtlasEnv() },
    });

    return {
      success: true,
      running: true,
      status: JSON.parse(result),
    };
  } catch (error) {
    // daemon status returns exit code 1 when not running
    if (error.status === 1) {
      return { success: true, running: false };
    }
    return {
      success: false,
      error: `Failed to check daemon status: ${error.message}`,
    };
  }
});

// Start or restart Atlas service
ipcMain.handle("manage-atlas-service", async (event, action = "start") => {
  try {
    const { execSync, spawn } = require("child_process");
    const fs = require("fs");
    const binaryPath = getAtlasBinaryPath();

    const envConfig = {
      ...process.env,
      ...getAtlasEnv(),
      PATH: process.platform === "win32"
        ? `${path.dirname(binaryPath)};${process.env.PATH}`
        : `${path.dirname(binaryPath)}:${process.env.PATH}`,
      HOME: os.homedir(),
      USER: process.env.USER || os.userInfo().username,
    };

    // Windows implementation
    if (process.platform === "win32") {
      const userProfile = process.env.USERPROFILE || process.env.HOME || "C:\\Users\\Default";

      if (action === "start") {
        try {
          // First, stop any existing Atlas daemon
          try {
            execSync(`"${binaryPath}" daemon stop`, {
              encoding: "utf8",
              timeout: 5000,
              env: envConfig,
              stdio: "ignore",
            });
            // Wait for daemon to stop
            await new Promise((resolve) => setTimeout(resolve, 2000));
          } catch {
            // Daemon might not be running, continue
          }

          // Kill any remaining atlas.exe processes
          try {
            execSync("taskkill /F /IM atlas.exe", { stdio: "ignore" });
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } catch {
            // No processes to kill
          }

          // Create Atlas daemon starter batch file
          const atlasStarterPath = path.join(
            userProfile,
            "AppData",
            "Local",
            "Atlas",
            "atlas-daemon.bat",
          );
          const daemonStarter = `@echo off
cd /d "${userProfile}"
"${binaryPath}" daemon start --port 8080
`;
          fs.writeFileSync(atlasStarterPath, daemonStarter);

          // Start daemon using Windows Task Scheduler for background execution
          try {
            // Create a scheduled task that runs now and at startup
            const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Atlas Daemon - AI Development Assistant</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${binaryPath}</Command>
      <Arguments>daemon start --port 8080</Arguments>
      <WorkingDirectory>${userProfile}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;

            const taskXmlPath = path.join(os.tmpdir(), "atlas-task.xml");
            fs.writeFileSync(taskXmlPath, taskXml);

            // Delete existing task if any
            try {
              execSync('schtasks /delete /tn "AtlasDaemon" /f', {
                stdio: "ignore",
              });
            } catch {
              // Task doesn't exist
            }

            // Create the task
            execSync(
              `schtasks /create /xml "${taskXmlPath}" /tn "AtlasDaemon"`,
              {
                encoding: "utf8",
                stdio: "ignore",
              },
            );

            // Start the task immediately
            execSync('schtasks /run /tn "AtlasDaemon"', {
              encoding: "utf8",
              stdio: "ignore",
            });

            // Clean up XML file
            try {
              fs.unlinkSync(taskXmlPath);
            } catch {}
          } catch (taskError) {
            // If Task Scheduler fails, log error but don't start daemon directly
            console.error(
              "Task Scheduler failed:",
              taskError,
            );
            // Return error instead of trying to start daemon in foreground
            return {
              success: false,
              action,
              error:
                `Failed to create Windows Task Scheduler entry for Atlas service: ${taskError.message}. Please run 'atlas service install' manually after installation.`,
            };
          }

          // Create Start Menu shortcut for Atlas client
          const startMenuPath = path.join(
            userProfile,
            "AppData",
            "Roaming",
            "Microsoft",
            "Windows",
            "Start Menu",
            "Programs",
          );

          // Create a proper Windows shortcut using PowerShell
          const createShortcutPS = `
            $WshShell = New-Object -ComObject WScript.Shell
            $Shortcut = $WshShell.CreateShortcut('${startMenuPath}\\Atlas.lnk')
            $Shortcut.TargetPath = '${binaryPath}'
            $Shortcut.WorkingDirectory = '${userProfile}'
            $Shortcut.IconLocation = '${binaryPath},0'
            $Shortcut.Description = 'Atlas AI Development Assistant'
            $Shortcut.Save()
          `
            .trim()
            .replace(/\n\s*/g, "; ");

          try {
            execSync(`powershell -Command "${createShortcutPS}"`, {
              windowsHide: true,
              stdio: "ignore",
            });
          } catch {
            // Fallback to batch file if PowerShell fails
            const atlasShortcut = `@echo off\nstart "" "${binaryPath}"`;
            fs.writeFileSync(
              path.join(startMenuPath, "Atlas.bat"),
              atlasShortcut,
            );
          }

          // Wait for daemon to start
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Verify daemon is running
          try {
            const statusResult = execSync(
              `"${binaryPath}" daemon status --json`,
              {
                encoding: "utf8",
                env: envConfig,
                timeout: 5000,
              },
            );

            return {
              success: true,
              action,
              message:
                `Atlas service started successfully!\n\nAtlas has been added to your PATH and Start Menu.\nYou can now use 'atlas' from any new command prompt or PowerShell window.`,
            };
          } catch {
            // Daemon might be starting, consider it success
            return {
              success: true,
              action,
              message:
                `Atlas service is starting...\n\nAtlas has been added to your PATH and Start Menu.\nYou can now use 'atlas' from any new command prompt or PowerShell window.`,
            };
          }
        } catch (error) {
          return {
            success: false,
            action,
            error: `Failed to start Atlas daemon: ${error.message}`,
          };
        }
      } else if (action === "stop") {
        try {
          // Stop Atlas daemon
          execSync(`"${binaryPath}" daemon stop`, {
            encoding: "utf8",
            timeout: 5000,
            env: envConfig,
            stdio: "ignore",
          });
        } catch {
          // Try force kill
          try {
            execSync("taskkill /F /IM atlas.exe", { stdio: "ignore" });
          } catch {}
        }

        // Remove scheduled task
        try {
          execSync('schtasks /delete /tn "AtlasDaemon" /f', {
            stdio: "ignore",
          });
        } catch {}

        return {
          success: true,
          action,
          message: `Atlas daemon stopped successfully`,
        };
      }
    } else if (process.platform === "darwin") {
      // macOS: use the service command approach
      if (action === "start") {
        // Add a delay to ensure binary is fully accessible after installation
        await new Promise((resolve) => setTimeout(resolve, 2000));

        try {
          // Verify binary exists and is executable before attempting service install
          fs.accessSync(binaryPath, fs.constants.F_OK | fs.constants.X_OK);
        } catch (accessError) {
          return {
            success: false,
            action,
            error:
              `Atlas binary not accessible at ${binaryPath}. Please verify installation completed successfully.`,
          };
        }

        try {
          // Always try to install/reinstall service to handle updates
          const installCommand = `"${binaryPath}" service install --force`;
          execSync(installCommand, {
            encoding: "utf8",
            timeout: 30000,
            env: envConfig,
            cwd: os.homedir(),
          });
        } catch (installError) {
          // If install fails, try without --force flag
          try {
            const installCommand = `"${binaryPath}" service install`;
            execSync(installCommand, {
              encoding: "utf8",
              timeout: 30000,
              env: envConfig,
              cwd: os.homedir(),
            });
          } catch (fallbackError) {
            const errorDetails = fallbackError.stderr || fallbackError.message;
            return {
              success: false,
              action,
              error:
                `Service install failed: ${errorDetails}. The LaunchAgent may not have been created at ~/Library/LaunchAgents/com.tempestdx.atlas.plist`,
            };
          }
        }

        // Verify the plist was actually created
        const plistPath = path.join(
          os.homedir(),
          "Library/LaunchAgents/com.tempestdx.atlas.plist",
        );
        if (!fs.existsSync(plistPath)) {
          return {
            success: false,
            action,
            error:
              `Service install command succeeded but LaunchAgent plist was not created at ${plistPath}. Please run 'atlas service install' manually after installation.`,
          };
        }
      }

      // Now execute the requested action
      const command = `"${binaryPath}" service ${action}`;
      const result = execSync(command, {
        encoding: "utf8",
        timeout: 30000,
        env: envConfig,
        cwd: os.homedir(),
      });

      return {
        success: true,
        action,
        message: `Atlas service ${action} completed successfully`,
      };
    } else {
      // Unsupported platform
      return {
        success: false,
        error: `Unsupported platform: ${process.platform}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      action,
      error: `Service ${action} failed: ${error.message}`,
    };
  }
});

// Legacy daemon management (kept for compatibility)
ipcMain.handle("manage-atlas-daemon", async (event, action = "start") => {
  try {
    const { execSync } = require("child_process");
    const binaryPath = getAtlasBinaryPath();

    // Add a small delay to ensure binary installation is fully complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check if binary exists first
    if (!fs.existsSync(binaryPath)) {
      return {
        success: false,
        error: `Atlas binary not found at ${binaryPath}. Binary installation may have failed.`,
      };
    }

    // Verify binary is executable
    try {
      fs.accessSync(binaryPath, fs.constants.F_OK | fs.constants.X_OK);
    } catch (accessError) {
      return {
        success: false,
        error: `Atlas binary at ${binaryPath} is not executable: ${accessError.message}`,
      };
    }

    // Check if daemon is already running
    let isAlreadyRunning = false;
    try {
      execSync(`"${binaryPath}" daemon status --json`, {
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          ...getAtlasEnv(),
        },
      });
      isAlreadyRunning = true;
    } catch {
      // Daemon not running, which is expected for start action
      isAlreadyRunning = false;
    }

    if (isAlreadyRunning && action === "start") {
      return {
        success: true,
        action,
        message: "Daemon is already running",
      };
    }

    // Handle daemon start vs restart differently
    if (action === "start") {
      // Use spawn to start daemon in background - more reliable than detached flag
      try {
        const { spawn } = require("child_process");

        const daemonProcess = spawn(binaryPath, ["daemon", "start"], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
          env: {
            ...process.env,
            ...getAtlasEnv(),
            PATH: process.platform === "win32"
              ? `${path.dirname(binaryPath)};${process.env.PATH}`
              : `${path.dirname(binaryPath)}:${process.env.PATH}`,
            HOME: os.homedir(),
            USER: process.env.USER || os.userInfo().username,
          },
          cwd: os.homedir(),
        });

        // Unref so the parent process doesn't wait for the child
        daemonProcess.unref();

        // Give it a moment to start
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Check if process started successfully by checking if it's still running
        if (daemonProcess.killed) {
          return {
            success: false,
            action,
            error: "Daemon process was killed immediately after start",
          };
        }
      } catch (spawnError) {
        return {
          success: false,
          action,
          error: `Failed to spawn daemon: ${spawnError.message}`,
        };
      }
    } else if (action === "restart") {
      // For restart, first stop then start
      try {
        // Stop the daemon first
        execSync(`"${binaryPath}" daemon stop`, {
          encoding: "utf8",
          timeout: 10000,
          env: { ...process.env, ...getAtlasEnv() },
        });
      } catch (stopError) {
        // If daemon wasn't running, that's okay
      }

      // Wait a moment for cleanup
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Start the daemon in detached mode
      const command = `"${binaryPath}" daemon start --detached`;
      try {
        execSync(command, {
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            ...getAtlasEnv(),
            PATH: process.platform === "win32"
              ? `${path.dirname(binaryPath)};${process.env.PATH}`
              : `${path.dirname(binaryPath)}:${process.env.PATH}`,
            HOME: os.homedir(),
            USER: process.env.USER || os.userInfo().username,
          },
          cwd: os.homedir(),
        });
      } catch (execError) {
        const errorMessage = `Stdout: ${execError.stdout || "N/A"}\nStderr: ${
          execError.stderr || "N/A"
        }\nError: ${execError.message}`;
        return {
          success: false,
          action,
          error: `Failed to ${action} daemon: ${errorMessage}`,
        };
      }
    } else {
      return {
        success: false,
        error: `Unknown daemon action: ${action}`,
      };
    }

    // Wait for daemon to start (give it more time to fully initialize)
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Verify daemon started successfully
    try {
      const status = execSync(`"${binaryPath}" daemon status --json`, {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          ...getAtlasEnv(),
          PATH: process.platform === "win32"
            ? `${path.dirname(binaryPath)};${process.env.PATH}`
            : `${path.dirname(binaryPath)}:${process.env.PATH}`,
          HOME: os.homedir(),
          USER: process.env.USER || os.userInfo().username,
        },
        cwd: os.homedir(),
      });

      return {
        success: true,
        action,
        status: JSON.parse(status),
      };
    } catch (statusError) {
      // If status check fails, the daemon didn't start properly
      const errorDetails = `Status check failed - Stdout: ${statusError.stdout || "N/A"}, Stderr: ${
        statusError.stderr || "N/A"
      }, Error: ${statusError.message}`;

      return {
        success: false,
        action,
        error:
          `Failed to start daemon: ${errorDetails}. Please start manually with 'atlas daemon start'.`,
      };
    }
  } catch (error) {
    return {
      success: false,
      action,
      error: `Unexpected error during daemon ${action}: ${error.message}`,
    };
  }
});

ipcMain.handle("get-eula-text", async () => {
  try {
    let eulaPath;
    if (app.isPackaged) {
      // In packaged app, EULA.txt is in the resources directory
      eulaPath = path.join(process.resourcesPath, "EULA.txt");
    } else {
      // In development, go up to project root
      eulaPath = path.join(__dirname, "..", "..", "EULA.txt");
    }

    const eulaText = fs.readFileSync(eulaPath, "utf8");
    return eulaText;
  } catch (error) {
    console.error("Failed to read EULA.txt:", error);
    // Return a fallback message if file can't be read
    return "Error loading license text. Please contact support@tempestdx.com for assistance.";
  }
});

ipcMain.handle("quit-app", () => {
  app.quit();
});
