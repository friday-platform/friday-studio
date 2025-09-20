import { contextBridge, ipcRenderer } from "electron";
import type { ServiceAction } from "./constants/actions";
import type { ElectronAPI } from "./types";

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
const electronAPI: ElectronAPI = {
  getPlatform: () => ipcRenderer.invoke("get-platform"),
  createAtlasDir: () => ipcRenderer.invoke("create-atlas-dir"),
  checkExistingApiKey: () => ipcRenderer.invoke("check-existing-api-key"),
  saveAtlasKey: (atlasKey: string) => ipcRenderer.invoke("save-atlas-key", atlasKey),
  saveAtlasNpxPath: () => ipcRenderer.invoke("save-atlas-npx-path"),
  installAtlasBinary: () => ipcRenderer.invoke("install-atlas-binary"),
  setupPath: () => ipcRenderer.invoke("setup-path"),
  checkAtlasBinary: () => ipcRenderer.invoke("check-atlas-binary"),
  manageService: (action: ServiceAction) => ipcRenderer.invoke("manage-atlas-service", action),
  quitApp: () => ipcRenderer.invoke("quit-app"),
  getEulaText: () => ipcRenderer.invoke("get-eula-text"),
  onInstallationProgress: (callback: (message: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string): void =>
      callback(message);
    ipcRenderer.on("installation-progress", listener);

    // Return cleanup function
    return () => {
      ipcRenderer.removeListener("installation-progress", listener);
    };
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
