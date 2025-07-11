const { contextBridge, ipcRenderer } = require("electron");

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  getPlatform: () => ipcRenderer.invoke("get-platform"),
  createAtlasDir: () => ipcRenderer.invoke("create-atlas-dir"),
  saveApiKey: (apiKey) => ipcRenderer.invoke("save-api-key", apiKey),
  installAtlasBinary: () => ipcRenderer.invoke("install-atlas-binary"),
  setupPath: () => ipcRenderer.invoke("setup-path"),
  quitApp: () => ipcRenderer.invoke("quit-app"),
});
