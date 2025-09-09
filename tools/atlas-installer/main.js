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
  return { platform: process.platform, arch: process.arch, homedir: os.homedir() };
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
    const hasAtlasKey =
      envContent.includes("ATLAS_KEY=") &&
      envContent.match(/ATLAS_KEY=eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);

    return { exists: !!hasAtlasKey };
  } catch (error) {
    return { exists: false, error: error.message };
  }
});

// Helper function to discover npx location
function findNpxPath() {
  const { execSync } = require("child_process");

  // Common NPX locations to check as fallback
  const commonNpxPaths = [
    "/opt/homebrew/bin/npx", // Homebrew on Apple Silicon
    "/usr/local/bin/npx", // Homebrew on Intel Mac or standard location
    "/usr/bin/npx", // System installation
    path.join(os.homedir(), ".nvm/versions/node/*/bin/npx"), // NVM (would need glob)
    path.join(os.homedir(), ".volta/bin/npx"), // Volta
    path.join(os.homedir(), ".asdf/shims/npx"), // asdf
  ];

  // First try to find via which/where command
  try {
    // On Windows, look for npx.cmd which is the actual executable
    const npxName = process.platform === "win32" ? "npx.cmd" : "npx";
    const cmd = process.platform === "win32" ? `where ${npxName}` : `which ${npxName}`;

    console.log(`[NPX Discovery] Running command: ${cmd}`);

    // On macOS, we need to run with a proper shell to get the full PATH
    const shellCmd =
      process.platform === "darwin"
        ? `/bin/bash -l -c "${cmd}"` // Use login shell to get full PATH
        : cmd;

    const result = execSync(shellCmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "darwin" ? false : true,
    }).trim();

    // On Windows, 'where' might return multiple paths, take the first one
    const npxPath = result.split("\n")[0].trim();

    console.log(`[NPX Discovery] Found npx via command at: ${npxPath}`);

    if (npxPath && fs.existsSync(npxPath)) {
      const stats = fs.statSync(npxPath);
      if (stats.isFile()) {
        // On Unix-like systems, check execute permission
        if (process.platform !== "win32") {
          const isExecutable = (stats.mode & 0o111) !== 0;
          if (isExecutable) {
            console.log(`[NPX Discovery] NPX path validated successfully: ${npxPath}`);
            return npxPath;
          }
        } else {
          // Windows .cmd files are executable by default
          return npxPath;
        }
      }
    }
  } catch (error) {
    console.warn(`[NPX Discovery] Could not find npx via command: ${error.message}`);
  }

  // Fallback: Check common locations directly
  console.log(`[NPX Discovery] Checking common NPX locations...`);
  for (const npxPath of commonNpxPaths) {
    try {
      // Handle glob patterns (for nvm)
      if (npxPath.includes("*")) {
        continue; // Skip glob patterns for now
      }

      if (fs.existsSync(npxPath)) {
        const stats = fs.statSync(npxPath);
        if (stats.isFile()) {
          // Check if executable on Unix
          if (process.platform !== "win32") {
            const isExecutable = (stats.mode & 0o111) !== 0;
            if (isExecutable) {
              console.log(`[NPX Discovery] Found npx at common location: ${npxPath}`);
              return npxPath;
            }
          }
        }
      }
    } catch (err) {
      // Continue checking other paths
    }
  }

  console.warn(`[NPX Discovery] Could not find npx in PATH or common locations`);
  return null;
}

// IPC handler for ensuring ATLAS_NPX_PATH is configured
ipcMain.handle("ensure-npx-path", async () => {
  try {
    const atlasDir = path.join(os.homedir(), ".atlas");
    const envFile = path.join(atlasDir, ".env");

    // Ensure .atlas directory exists
    if (!fs.existsSync(atlasDir)) {
      fs.mkdirSync(atlasDir, { recursive: true });
    }

    let existingLines = [];

    // Read existing .env file if it exists
    if (fs.existsSync(envFile)) {
      const existingContent = fs.readFileSync(envFile, "utf8");
      existingLines = existingContent.split("\n");
    }

    // Check if ATLAS_NPX_PATH already exists
    const hasExistingNpxPath = existingLines.some((line) =>
      line.trim().startsWith("ATLAS_NPX_PATH="),
    );

    if (!hasExistingNpxPath) {
      const npxPath = findNpxPath();
      if (npxPath) {
        // Add ATLAS_NPX_PATH to the file
        existingLines.push(`ATLAS_NPX_PATH=${npxPath}`);

        // Write back to file
        const envContent = existingLines.filter((line) => line.trim()).join("\n") + "\n";
        fs.writeFileSync(envFile, envContent, "utf8");

        // Set file permissions (Unix-like systems)
        if (process.platform !== "win32") {
          fs.chmodSync(envFile, 0o600);
        }

        return { success: true, npxPath, message: "ATLAS_NPX_PATH configured successfully" };
      } else {
        return { success: false, error: "Could not find npx executable in PATH" };
      }
    } else {
      return { success: true, message: "ATLAS_NPX_PATH already configured" };
    }
  } catch (error) {
    return { success: false, error: error.message };
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

    // Filter out any existing ATLAS_KEY and ATLAS_NPX_PATH lines
    const filteredLines = existingLines.filter((line) => {
      const trimmedLine = line.trim();
      return !trimmedLine.startsWith("ATLAS_KEY=") && !trimmedLine.startsWith("ATLAS_NPX_PATH=");
    });

    // Add the new ATLAS_KEY
    filteredLines.push(`ATLAS_KEY=${atlasKey}`);

    // Find and store npx path if not already configured
    const hasExistingNpxPath = existingLines.some((line) =>
      line.trim().startsWith("ATLAS_NPX_PATH="),
    );
    if (!hasExistingNpxPath) {
      const npxPath = findNpxPath();
      if (npxPath) {
        filteredLines.push(`ATLAS_NPX_PATH=${npxPath}`);
      }
    }

    // Join lines and ensure file ends with newline
    envContent = filteredLines.filter((line) => line.trim()).join("\n") + "\n";

    // Write the updated .env file
    fs.writeFileSync(envFile, envContent, "utf8");

    // Set file permissions (Unix-like systems)
    if (process.platform !== "win32") {
      fs.chmodSync(envFile, 0o600);
    }

    return { success: true, path: envFile, message: "Atlas Access Key saved successfully" };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("install-atlas-binary", async (event) => {
  const { execSync } = require("child_process");
  const crypto = require("crypto");
  const ATLAS_WEB_CLIENT_APP = "Atlas Web Client.app";

  // Helper function to safely send progress updates
  const sendProgress = (message) => {
    if (event && event.sender) {
      event.sender.send("installation-progress", message);
    }
  };

  try {
    // Define binaries to install
    const binaries = [
      { name: process.platform === "win32" ? "atlas.exe" : "atlas" },
      { name: process.platform === "win32" ? "atlas-diagnostics.exe" : "atlas-diagnostics" },
    ];

    // Only require web app binary on non-mac platforms
    if (process.platform !== "darwin") {
      binaries.push({ name: process.platform === "win32" ? "atlas-web-app.exe" : "atlas-web-app" });
    }

    const resourcesPath = process.resourcesPath || path.dirname(path.dirname(__dirname));
    const results = [];

    for (const binary of binaries) {
      let binarySource = path.join(resourcesPath, "app.asar.unpacked", "atlas-binary", binary.name);

      if (!fs.existsSync(binarySource)) {
        // Fallback to development location
        binarySource = path.join(__dirname, "atlas-binary", binary.name);
      }

      // Fail if any binary doesn't exist (all are required)
      if (!fs.existsSync(binarySource)) {
        throw new Error(`Required binary ${binary.name} not found in installer package`);
      }

      // Determine installation path based on platform
      let installPath;
      if (process.platform === "win32") {
        const userProfile = process.env.USERPROFILE || process.env.HOME || "C:\\Users\\Default";
        installPath = path.join(userProfile, "AppData", "Local", "Atlas", binary.name);

        const installDir = path.dirname(installPath);
        if (!fs.existsSync(installDir)) {
          fs.mkdirSync(installDir, { recursive: true });
        }

        // Handle existing binary - stop daemon if running and overwrite
        if (fs.existsSync(installPath)) {
          try {
            // Try to stop the daemon gracefully first (only for atlas main binary)
            if (binary.name.includes("atlas.exe") && !binary.name.includes("diagnostics")) {
              try {
                execSync(`"${installPath}" daemon stop`, { timeout: 5000, stdio: "ignore" });
              } catch {
                // If daemon stop fails, force kill atlas processes
                try {
                  execSync("taskkill /F /IM atlas.exe", { timeout: 5000, stdio: "ignore" });
                } catch {
                  // Ignore if no processes to kill
                }
              }
              // Wait a moment for processes to terminate
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          } catch {
            // Continue with installation even if stop fails
          }
        }

        // Copy binary (overwrite existing)
        fs.copyFileSync(binarySource, installPath);

        // Update PATH for Windows (only once for the directory)
        if (binary.name === (process.platform === "win32" ? "atlas.exe" : "atlas")) {
          try {
            const psCommand = `
              $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
              if ($userPath -notlike "*${installDir}*") {
                [Environment]::SetEnvironmentVariable('Path', $userPath + ';${installDir}', 'User')
              }
            `.trim();

            execSync(`powershell -Command "${psCommand}"`, { windowsHide: true, stdio: "ignore" });
          } catch {
            // PATH update failed silently
          }
        }
      } else if (process.platform === "darwin") {
        // macOS: Use symlink-based installation
        const userBinaryPath = path.join(
          os.homedir(),
          ".atlas",
          "bin",
          binary.name.replace(".exe", ""),
        );
        const systemBinaryPath = path.join("/usr/local/bin", binary.name.replace(".exe", ""));

        try {
          // First check if binary is currently running and stop it if necessary
          if (fs.existsSync(systemBinaryPath)) {
            try {
              // Try to stop the service/daemon (only for main atlas binary)
              if (binary.name.includes("atlas") && !binary.name.includes("diagnostics")) {
                try {
                  execSync(`"${systemBinaryPath}" service stop`, {
                    timeout: 5000,
                    stdio: "ignore",
                  });
                  await new Promise((resolve) => setTimeout(resolve, 2000));
                } catch {
                  try {
                    execSync(`"${systemBinaryPath}" daemon stop`, {
                      timeout: 5000,
                      stdio: "ignore",
                    });
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                  } catch {
                    try {
                      execSync("pkill -f atlas", { timeout: 5000, stdio: "ignore" });
                      await new Promise((resolve) => setTimeout(resolve, 1000));
                    } catch {
                      // Ignore if no processes to kill
                    }
                  }
                }
              }
            } catch {
              // Continue with installation
            }
          }

          // Create user binary directory
          const userBinDir = path.dirname(userBinaryPath);
          if (!fs.existsSync(userBinDir)) {
            fs.mkdirSync(userBinDir, { recursive: true });
          }

          // Copy binary to user location (overwrite existing)
          fs.copyFileSync(binarySource, userBinaryPath);
          fs.chmodSync(userBinaryPath, 0o755);

          // Prepare the installation command for symlink
          let installCommand;
          if (fs.existsSync(systemBinaryPath)) {
            // Replace existing installation
            installCommand = `rm -f ${systemBinaryPath} && ln -sf ${userBinaryPath} ${systemBinaryPath}`;
          } else {
            // Fresh installation
            installCommand = `ln -sf ${userBinaryPath} ${systemBinaryPath}`;
          }

          // Execute with admin privileges
          const script = `do shell script "${installCommand}" with administrator privileges with prompt "Atlas Installer needs administrator access to create symlinks in /usr/local/bin/"`;
          execSync(`osascript -e '${script}'`);

          installPath = userBinaryPath;
        } catch (execError) {
          throw new Error(`Installation failed for ${binary.name}: ${execError.message}`);
        }
      } else {
        // Linux: Install to ~/.local/bin
        const installDir = path.join(os.homedir(), ".local", "bin");
        installPath = path.join(installDir, binary.name);

        if (!fs.existsSync(installDir)) {
          fs.mkdirSync(installDir, { recursive: true });
        }

        // Copy binary (overwrite existing)
        fs.copyFileSync(binarySource, installPath);
        fs.chmodSync(installPath, 0o755);
      }

      results.push({ binary: binary.name, installed: installPath });
    }

    // macOS: automatically install Atlas Web Client from DMG to ~/Applications
    if (process.platform === "darwin") {
      const dmgName = "AtlasWebApp.dmg";
      let dmgSource = path.join(resourcesPath, "app.asar.unpacked", "atlas-binary", dmgName);

      if (!fs.existsSync(dmgSource)) {
        dmgSource = path.join(__dirname, "atlas-binary", dmgName);
      }

      if (!fs.existsSync(dmgSource)) {
        const errorMsg = `Required web app ${dmgName} not found in installer package. Searched: ${path.join(resourcesPath, "app.asar.unpacked", "atlas-binary", dmgName)} and ${path.join(__dirname, "atlas-binary", dmgName)}`;
        throw new Error(errorMsg);
      }

      try {
        // Send progress update
        sendProgress("Preparing Atlas Web Client installation...");

        // ALWAYS check for and remove existing installation in /Applications when installing to ~/Applications
        const systemAppPath = path.join("/Applications", ATLAS_WEB_CLIENT_APP);
        if (fs.existsSync(systemAppPath)) {
          sendProgress("Removing old installation from /Applications...");
          try {
            // Create a temporary script file with secure random name to prevent race conditions
            const randomSuffix = crypto.randomBytes(16).toString("hex");
            const tmpScript = path.join(os.tmpdir(), `atlas-remove-${randomSuffix}.sh`);
            fs.writeFileSync(tmpScript, `#!/bin/bash\nrm -rf "${systemAppPath}"\n`, {
              mode: 0o755,
            });

            // Properly escape the path to prevent injection attacks
            const escapedScript = tmpScript.replace(/'/g, "'\\''");

            // Use AppleScript to run the script with admin privileges
            const appleScript = `do shell script "bash '${escapedScript}'" with administrator privileges with prompt "Atlas Installer needs administrator access to remove the old version of Atlas Web Client from /Applications"`;

            // Pass AppleScript through stdin to avoid quote escaping issues
            execSync("osascript -", { input: appleScript, encoding: "utf8" });

            // Clean up temp script
            try {
              fs.unlinkSync(tmpScript);
            } catch (e) {
              // Ignore cleanup errors
            }
          } catch (removeError) {
            console.log(
              `Could not remove ${ATLAS_WEB_CLIENT_APP} from /Applications (user may have cancelled): ${removeError.message}`,
            );
            // Temp script cleanup happens in the outer try block
            // Continue anyway - we'll install to ~/Applications
          }
        }

        // Unmount if already mounted
        sendProgress("Checking for existing mounts...");
        try {
          // Check if this DMG is already mounted and unmount it
          const infoOutput = execSync("hdiutil info", { encoding: "utf8" });
          if (infoOutput.includes(dmgSource)) {
            // Find the mount point for this DMG
            const lines = infoOutput.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(dmgSource)) {
                // Look forward for the mount point (it appears after the image-path)
                for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
                  if (lines[j].includes("/Volumes")) {
                    // Extract mount point from line like: /dev/disk5s1 UUID /Volumes/Atlas
                    const parts = lines[j].trim().split(/\s+/);
                    const volumePath = parts.find((p) => p.startsWith("/Volumes"));
                    if (volumePath) {
                      console.log(`DMG already mounted at ${volumePath}, unmounting...`);
                      execSync(`hdiutil detach "${volumePath}" -force`, { stdio: "ignore" });
                      // Wait a moment for unmount to complete (using sync sleep as we're not in async context)
                      execSync("sleep 1", { stdio: "ignore" });
                      break;
                    }
                  }
                }
                break;
              }
            }
          }
        } catch (err) {
          console.warn(`Unmount check failed: ${err.message}`);
        }

        // Mount the DMG silently (without opening Finder window)
        sendProgress("Mounting disk image...");
        let mountOutput;
        let mountPoint = "";
        try {
          mountOutput = execSync(`hdiutil attach "${dmgSource}" -nobrowse -noautoopen`, {
            encoding: "utf8",
          });
        } catch (mountError) {
          throw mountError;
        }

        // Parse mount point - look for /Volumes path in the output
        // hdiutil output format: device-node \t partition-type \t mount-point
        const lines = mountOutput.split("\n");
        for (const line of lines) {
          if (line.includes("/Volumes")) {
            // The mount point is after the last tab on lines containing /Volumes
            const parts = line.split("\t");
            const lastPart = parts[parts.length - 1];
            if (lastPart && lastPart.includes("/Volumes")) {
              mountPoint = lastPart.trim();
              break;
            }
          }
        }

        // Fallback to last line parsing if /Volumes not found
        if (!mountPoint) {
          const lastLine = mountOutput.trim().split("\n").pop();
          if (lastLine) {
            const parts = lastLine.split("\t");
            mountPoint = parts[parts.length - 1].trim();
          }
        }

        // Start try block for cleanup in finally
        try {
          // Note: Disk space check removed as statfsSync doesn't exist in Node.js
          // The app is ~200MB and macOS will show an error if disk is full during copy

          // Ensure ~/Applications directory exists and resolve symlinks
          sendProgress("Preparing installation directory...");
          const userAppsDirRaw = path.join(os.homedir(), "Applications");
          if (!fs.existsSync(userAppsDirRaw)) {
            fs.mkdirSync(userAppsDirRaw, { recursive: true });
          }
          // Resolve symlinks to get the real path
          const userAppsDir = fs.realpathSync(userAppsDirRaw);

          // Define source and destination paths
          const appSource = path.join(mountPoint, ATLAS_WEB_CLIENT_APP);
          const appDest = path.join(userAppsDir, ATLAS_WEB_CLIENT_APP);

          // Verify the app exists in the DMG
          if (!fs.existsSync(appSource)) {
            // Try to find any .app file in the DMG
            const dmgFiles = fs.readdirSync(mountPoint);
            const appFile = dmgFiles.find((f) => f.endsWith(".app"));
            if (appFile) {
              throw new Error(
                `${ATLAS_WEB_CLIENT_APP} not found in mounted DMG at ${appSource}, but found ${appFile}`,
              );
            } else {
              throw new Error(
                `${ATLAS_WEB_CLIENT_APP} not found in mounted DMG at ${appSource}, DMG contains: ${dmgFiles.join(", ")}`,
              );
            }
          }

          // Remove existing app if present
          if (fs.existsSync(appDest)) {
            sendProgress("Removing old version from ~/Applications...");
            fs.rmSync(appDest, { recursive: true, force: true });
          }

          // Copy the app to ~/Applications
          sendProgress("Installing Atlas Web Client...");
          try {
            fs.cpSync(appSource, appDest, { recursive: true });

            // Verify the copy was successful
            if (!fs.existsSync(appDest)) {
              throw new Error(`Copy appeared to succeed but app not found at ${appDest}`);
            }
          } catch (copyError) {
            console.error(`Failed to copy app: ${copyError.message}`);
            throw copyError;
          }

          // Clear quarantine attributes to avoid Gatekeeper issues
          try {
            execSync(`xattr -cr "${appDest}"`, { stdio: "ignore" });
          } catch {
            // Non-critical - app is signed and notarized so should work anyway
          }

          results.push({ webApp: ATLAS_WEB_CLIENT_APP, installed: appDest, autoInstalled: true });

          sendProgress("Atlas Web Client installed successfully!");
          console.log(`${ATLAS_WEB_CLIENT_APP} installed successfully to ~/Applications`);
        } finally {
          // Always try to unmount the DMG
          if (mountPoint) {
            sendProgress("Cleaning up...");
            try {
              execSync(`hdiutil detach "${mountPoint}" -quiet`, { stdio: "ignore" });
              console.log("DMG unmounted successfully");
            } catch (detachError) {
              // Non-critical error - DMG will auto-unmount eventually
              console.warn(`Warning: Could not unmount DMG (non-critical): ${detachError.message}`);
            }
          }
        }
      } catch (error) {
        console.error(`Auto-installation failed: ${error.message}`);
        console.log("Falling back to manual installation...");

        // Fallback: Open DMG for manual installation
        try {
          execSync(`open "${dmgSource}"`);
          results.push({
            webApp: dmgName,
            opened: true,
            path: dmgSource,
            autoInstalled: false,
            fallbackReason: error.message,
          });
        } catch (openError) {
          // Both auto-install and fallback failed - this is a critical error
          const errorMsg = `Failed to install Atlas Web Client. Auto-install error: ${error.message}. Fallback error: ${openError.message}`;
          console.error(errorMsg);
          results.push({
            webApp: dmgName,
            opened: false,
            path: dmgSource,
            autoInstalled: false,
            error: errorMsg,
          });
          // Return the error to the renderer so it shows in the UI
          return { success: false, error: errorMsg, _installed: results };
        }
      }
    }

    return {
      success: true,
      message: "Atlas CLI installed successfully",
      // Internal tracking of what was installed
      _installed: results,
    };
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
          fs.writeFileSync(path.join(startMenuPath, "Atlas.bat"), atlasShortcut);
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

          execSync(`powershell -Command "${psCommand}"`, { windowsHide: true, stdio: "ignore" });

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
          message: `Atlas has been added to your PATH and Start Menu.\n\nYou can now use 'atlas' from any new command prompt or PowerShell window.\n\nNote: If 'atlas' is not recognized in existing terminals, please close and reopen them.`,
        };
      } catch (error) {
        return { success: true, message: `Setup completed. Atlas installed at ${atlasDir}` };
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
      return { exists: false, error: `Binary not found at ${binaryPath}` };
    }

    // Check if binary is accessible (especially important on Unix systems)
    try {
      fs.accessSync(binaryPath, fs.constants.F_OK | fs.constants.R_OK);

      // On Windows, also check if it's executable
      if (process.platform === "win32") {
        // Try to get basic info about the file
        const stats = fs.statSync(binaryPath);
        if (!stats.isFile()) {
          return { exists: false, error: `Path exists but is not a file: ${binaryPath}` };
        }
      } else {
        // On Unix, check execute permissions
        fs.accessSync(binaryPath, fs.constants.X_OK);
      }
    } catch (accessError) {
      return { exists: false, error: `Binary not accessible: ${accessError.message}` };
    }

    return { exists: true, path: binaryPath };
  } catch (error) {
    return { exists: false, error: `Failed to check binary: ${error.message}` };
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

    return { success: true, running: true, status: JSON.parse(result) };
  } catch (error) {
    // daemon status returns exit code 1 when not running
    if (error.status === 1) {
      return { success: true, running: false };
    }
    return { success: false, error: `Failed to check daemon status: ${error.message}` };
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
      PATH:
        process.platform === "win32"
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

          // Ensure the Windows service is actually installed before scheduling a start
          try {
            // Prefer a forced reinstall to keep Startup entry and config in sync
            execSync(`"${binaryPath}" service install --force --port 8080`, {
              encoding: "utf8",
              timeout: 30000,
              env: envConfig,
              cwd: os.homedir(),
              stdio: "ignore",
            });
          } catch {
            // Fallback to non-force if force is not supported
            try {
              execSync(`"${binaryPath}" service install --port 8080`, {
                encoding: "utf8",
                timeout: 30000,
                env: envConfig,
                cwd: os.homedir(),
                stdio: "ignore",
              });
            } catch (installErr) {
              return {
                success: false,
                action,
                error: `Failed to install Atlas service on Windows: ${installErr.message}`,
              };
            }
          }

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
      <Arguments>service start</Arguments>
      <WorkingDirectory>${userProfile}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;

            const taskXmlPath = path.join(os.tmpdir(), "atlas-task.xml");
            fs.writeFileSync(taskXmlPath, taskXml);

            // Delete existing task if any
            try {
              execSync('schtasks /delete /tn "AtlasDaemon" /f', { stdio: "ignore" });
            } catch {
              // Task doesn't exist
            }

            // Create the task to run service start on logon (service is pre-installed above)
            execSync(`schtasks /create /xml "${taskXmlPath}" /tn "AtlasDaemon"`, {
              encoding: "utf8",
              stdio: "ignore",
            });

            // Start the task immediately (runs: atlas service start)
            execSync('schtasks /run /tn "AtlasDaemon"', { encoding: "utf8", stdio: "ignore" });

            // Clean up XML file
            try {
              fs.unlinkSync(taskXmlPath);
            } catch {}
          } catch (taskError) {
            // If Task Scheduler fails, log error but don't start daemon directly
            console.error("Task Scheduler failed:", taskError);
            // Return error instead of trying to start daemon in foreground
            return {
              success: false,
              action,
              error: `Failed to create Windows Task Scheduler entry for Atlas service: ${taskError.message}. Please run 'atlas service install' manually after installation.`,
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
            fs.writeFileSync(path.join(startMenuPath, "Atlas.bat"), atlasShortcut);
          }

          // Wait for daemon to start
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Verify daemon is running
          try {
            const statusResult = execSync(`"${binaryPath}" daemon status --json`, {
              encoding: "utf8",
              env: envConfig,
              timeout: 5000,
            });

            return {
              success: true,
              action,
              message: `Atlas service started successfully!\n\nAtlas has been added to your PATH and Start Menu.\nYou can now use 'atlas' from any new command prompt or PowerShell window.`,
            };
          } catch {
            // Daemon might be starting, consider it success
            return {
              success: true,
              action,
              message: `Atlas service is starting...\n\nAtlas has been added to your PATH and Start Menu.\nYou can now use 'atlas' from any new command prompt or PowerShell window.`,
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
          execSync('schtasks /delete /tn "AtlasDaemon" /f', { stdio: "ignore" });
        } catch {}

        return { success: true, action, message: `Atlas daemon stopped successfully` };
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
            error: `Atlas binary not accessible at ${binaryPath}. Please verify installation completed successfully.`,
          };
        }

        try {
          // First try to stop any existing service
          try {
            execSync(`"${binaryPath}" service stop`, {
              encoding: "utf8",
              timeout: 10000,
              env: envConfig,
              stdio: "ignore",
            });
            // Wait for service to stop
            await new Promise((resolve) => setTimeout(resolve, 2000));
          } catch {
            // Service might not be running, continue
          }

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
              error: `Service install failed: ${errorDetails}. The LaunchAgent may not have been created at ~/Library/LaunchAgents/com.tempestdx.atlas.plist`,
            };
          }
        }

        // Verify the plist was actually created
        const plistPath = path.join(os.homedir(), "Library/LaunchAgents/com.tempestdx.atlas.plist");
        if (!fs.existsSync(plistPath)) {
          return {
            success: false,
            action,
            error: `Service install command succeeded but LaunchAgent plist was not created at ${plistPath}. Please run 'atlas service install' manually after installation.`,
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

      return { success: true, action, message: `Atlas service ${action} completed successfully` };
    } else {
      // Unsupported platform
      return { success: false, error: `Unsupported platform: ${process.platform}` };
    }
  } catch (error) {
    return { success: false, action, error: `Service ${action} failed: ${error.message}` };
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
        env: { ...process.env, ...getAtlasEnv() },
      });
      isAlreadyRunning = true;
    } catch {
      // Daemon not running, which is expected for start action
      isAlreadyRunning = false;
    }

    if (isAlreadyRunning && action === "start") {
      return { success: true, action, message: "Daemon is already running" };
    }

    // Handle daemon start vs restart differently
    if (action === "start") {
      // Use spawn to start daemon in background - more reliable than detached flag
      try {
        const { spawn } = require("child_process");

        // Use service start instead of daemon start for proper background execution
        const serviceArgs =
          process.platform === "win32"
            ? ["service", "start"] // Windows: use service
            : ["daemon", "start"]; // Unix: daemon can detach properly

        const daemonProcess = spawn(binaryPath, serviceArgs, {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
          env: {
            ...process.env,
            ...getAtlasEnv(),
            PATH:
              process.platform === "win32"
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
        return { success: false, action, error: `Failed to spawn daemon: ${spawnError.message}` };
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
            PATH:
              process.platform === "win32"
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
        return { success: false, action, error: `Failed to ${action} daemon: ${errorMessage}` };
      }
    } else {
      return { success: false, error: `Unknown daemon action: ${action}` };
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
          PATH:
            process.platform === "win32"
              ? `${path.dirname(binaryPath)};${process.env.PATH}`
              : `${path.dirname(binaryPath)}:${process.env.PATH}`,
          HOME: os.homedir(),
          USER: process.env.USER || os.userInfo().username,
        },
        cwd: os.homedir(),
      });

      return { success: true, action, status: JSON.parse(status) };
    } catch (statusError) {
      // If status check fails, the daemon didn't start properly
      const errorDetails = `Status check failed - Stdout: ${statusError.stdout || "N/A"}, Stderr: ${
        statusError.stderr || "N/A"
      }, Error: ${statusError.message}`;

      return {
        success: false,
        action,
        error: `Failed to start daemon: ${errorDetails}. Please start manually with 'atlas daemon start'.`,
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
