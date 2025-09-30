/**
 * Check if the app is running in Tauri environment (desktop app)
 * vs browser environment (web dev mode)
 */
export function isTauriApp(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}
