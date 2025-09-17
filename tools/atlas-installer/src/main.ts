import * as path from "node:path";
import * as os from "node:os";
import { app, BrowserWindow, ipcMain } from "electron";
import { isMac, isWindows } from "./utils/platform";
import { addToSystemPath, addToShellProfiles } from "./services/path-manager";
import {
  getPlatformHandler,
  createAtlasDirHandler,
  checkExistingApiKeyHandler,
  saveAtlasNpxPathHandler,
  saveAtlasKeyHandler,
  quitAppHandler,
  installAtlasBinaryHandler,
  checkAtlasBinaryHandler,
  manageAtlasServiceHandler,
  checkAtlasDaemonStatus,
  manageAtlasDaemon,
  getEulaTextHandler,
} from "./handlers";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 950,
    height: 850,
    resizable: true,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: "hiddenInset",
    fullscreenable: false,
    maximizable: false,
    ...(!isMac() ? { titleBarOverlay: true } : {}),
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
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (!isMac()) {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Register IPC handlers
ipcMain.handle("get-platform", getPlatformHandler);
ipcMain.handle("create-atlas-dir", createAtlasDirHandler);
ipcMain.handle("check-existing-api-key", checkExistingApiKeyHandler);
ipcMain.handle("save-atlas-npx-path", saveAtlasNpxPathHandler);
ipcMain.handle("save-atlas-key", saveAtlasKeyHandler);
ipcMain.handle("install-atlas-binary", installAtlasBinaryHandler);
ipcMain.handle("check-atlas-binary", checkAtlasBinaryHandler);
// Inline the thin setup handler
ipcMain.handle("setup-path", async () => {
  const atlasDir = path.join(os.homedir(), ".atlas");

  if (isWindows()) {
    const result = await addToSystemPath(atlasDir);
    if (!result.success) return result;

    return {
      success: true,
      message:
        "Atlas has been added to your system PATH.\n\n" +
        "You can now use 'atlas' from any new command prompt or PowerShell window.",
    };
  }

  if (isMac()) {
    const result = await addToShellProfiles(atlasDir);
    if (!result.success) return result;

    return {
      success: true,
      message:
        "Atlas has been added to your shell profiles.\n\n" +
        "You can now use 'atlas' from any new terminal window.",
    };
  }

  return { success: false, error: `Unsupported platform: ${process.platform}` };
});
ipcMain.handle("manage-atlas-service", manageAtlasServiceHandler);
ipcMain.handle("check-atlas-daemon-status", checkAtlasDaemonStatus);
ipcMain.handle("manage-atlas-daemon", manageAtlasDaemon);
ipcMain.handle("get-eula-text", getEulaTextHandler);
ipcMain.handle("quit-app", quitAppHandler);
