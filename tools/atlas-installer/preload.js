const { contextBridge, ipcRenderer } = require("electron");

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  getPlatform: () => ipcRenderer.invoke("get-platform"),
  createAtlasDir: () => ipcRenderer.invoke("create-atlas-dir"),
  checkExistingApiKey: () => ipcRenderer.invoke("check-existing-api-key"),
  saveAtlasKey: (atlasKey) => ipcRenderer.invoke("save-atlas-key", atlasKey),
  installAtlasBinary: () => ipcRenderer.invoke("install-atlas-binary"),
  setupPath: () => ipcRenderer.invoke("setup-path"),
  checkAtlasBinary: () => ipcRenderer.invoke("check-atlas-binary"),
  checkDaemonStatus: () => ipcRenderer.invoke("check-daemon-status"),
  manageDaemon: (action) => ipcRenderer.invoke("manage-atlas-daemon", action),
  manageService: (action) => ipcRenderer.invoke("manage-atlas-service", action),
  quitApp: () => ipcRenderer.invoke("quit-app"),
  getEulaText: () => ipcRenderer.invoke("get-eula-text"),
});
