/**
 * Centralized Tauri API loader
 *
 * Call initTauri() early in app lifecycle (from root layout), then use exports normally.
 * Tree-shakeable: When __TAURI_BUILD__ is false, all imports are eliminated by Vite.
 *
 * Usage:
 *   // In root layout onMount:
 *   await initTauri();
 *
 *   // In other components:
 *   if (invoke) {
 *     await invoke('command');
 *   }
 */

declare const __TAURI_BUILD__: boolean;

let _tauriCore: typeof import("@tauri-apps/api/core") | undefined;
let _tauriApp: typeof import("@tauri-apps/api/app") | undefined;
let _tauriWebview: typeof import("@tauri-apps/api/webview") | undefined;
let _tauriWindow: typeof import("@tauri-apps/api/window") | undefined;
let _tauriEvent: typeof import("@tauri-apps/api/event") | undefined;
let _tauriOpener: typeof import("@tauri-apps/plugin-opener") | undefined;
let _tauriNotification: typeof import("@tauri-apps/plugin-notification") | undefined;
let _tauriFs: typeof import("@tauri-apps/plugin-fs") | undefined;

let _initPromise: Promise<void> | undefined;

/**
 * Initialize Tauri APIs
 * Call this from root layout's onMount to load Tauri modules
 */
export async function initTauri(): Promise<void> {
  if (_initPromise) return _initPromise;
  if (!__TAURI_BUILD__) return;
  if (_tauriCore) return; // Already initialized

  _initPromise = (async () => {
    [
      _tauriCore,
      _tauriApp,
      _tauriWebview,
      _tauriWindow,
      _tauriEvent,
      _tauriOpener,
      _tauriNotification,
      _tauriFs,
    ] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/app"),
      import("@tauri-apps/api/webview"),
      import("@tauri-apps/api/window"),
      import("@tauri-apps/api/event"),
      import("@tauri-apps/plugin-opener"),
      import("@tauri-apps/plugin-notification"),
      import("@tauri-apps/plugin-fs"),
    ]);
  })();

  await _initPromise;
}

// Core API
export const invoke = __TAURI_BUILD__
  ? (cmd: string, args?: Record<string, unknown>) => _tauriCore?.invoke(cmd, args)
  : undefined;

// App API
export const getVersion = __TAURI_BUILD__ ? () => _tauriApp?.getVersion() : undefined;

// Webview API
export const Webview = __TAURI_BUILD__ ? _tauriWebview?.Webview : undefined;

// Window API
export const Window = __TAURI_BUILD__ ? _tauriWindow?.Window : undefined;

// Event API
export const listen = __TAURI_BUILD__
  ? (event: string, handler: (event: unknown) => void) => _tauriEvent?.listen(event, handler)
  : undefined;

// Opener plugin
export const openPath = __TAURI_BUILD__
  ? (path: string) => _tauriOpener?.openPath(path)
  : undefined;

export const openUrl = __TAURI_BUILD__ ? (url: string) => _tauriOpener?.openUrl(url) : undefined;

// Notification plugin
export const isPermissionGranted = __TAURI_BUILD__
  ? () => _tauriNotification?.isPermissionGranted()
  : undefined;
export const requestPermission = __TAURI_BUILD__
  ? () => _tauriNotification?.requestPermission()
  : undefined;
export const sendNotification = __TAURI_BUILD__
  ? (options: { title: string; body: string; sound?: string }) =>
      _tauriNotification?.sendNotification(options)
  : undefined;

// FS plugin
export const writeTextFile = __TAURI_BUILD__
  ? (path: string, contents: string, options?: { baseDir?: number }) =>
      _tauriFs?.writeTextFile(path, contents, options)
  : undefined;

export const openFile = __TAURI_BUILD__
  ? (path: string, options?: { read?: boolean; baseDir?: number }) => _tauriFs?.open(path, options)
  : undefined;

// BaseDirectory enum values (from @tauri-apps/plugin-fs)
export const BaseDirectory = __TAURI_BUILD__
  ? {
      Download: 6, // BaseDirectory.Download value
    }
  : undefined;
