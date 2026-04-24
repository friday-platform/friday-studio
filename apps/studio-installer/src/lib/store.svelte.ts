// Step enum — linear install flow
export type Step = "welcome" | "license" | "api-keys" | "download" | "extract" | "launch" | "done";

// Install mode determined at startup
export type InstallMode = "fresh" | "update" | "current";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(secs: number): string {
  if (!isFinite(secs) || secs < 0) return "--";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function createStore() {
  // Current step
  let step = $state<Step>("welcome");

  // Install detection results
  let mode = $state<InstallMode>("fresh");
  let installedVersion = $state<string | null>(null);
  let availableVersion = $state<string>("");
  let studioRunning = $state(false);

  // License
  let licenseAccepted = $state(false);
  let licenseScrolledToBottom = $state(false);

  // API keys
  let anthropicKey = $state("");
  let openaiKey = $state("");

  // Download progress
  let downloadedBytes = $state(0);
  let totalBytes = $state(0);
  let bytesPerSec = $state(0);
  let downloadError = $state<string | null>(null);

  // Retry state (cleared when a progress event arrives after a successful retry)
  let retryAttempt = $state(0);
  let retryMax = $state(0);
  let retryDelaySecs = $state(0);
  let retryError = $state<string | null>(null);

  // Path to the downloaded archive (set after download starts)
  let downloadPath = $state<string>("");

  // General error
  let error = $state<string | null>(null);

  return {
    get step() {
      return step;
    },
    set step(v: Step) {
      step = v;
    },

    get mode() {
      return mode;
    },
    set mode(v: InstallMode) {
      mode = v;
    },

    get installedVersion() {
      return installedVersion;
    },
    set installedVersion(v: string | null) {
      installedVersion = v;
    },

    get availableVersion() {
      return availableVersion;
    },
    set availableVersion(v: string) {
      availableVersion = v;
    },

    get studioRunning() {
      return studioRunning;
    },
    set studioRunning(v: boolean) {
      studioRunning = v;
    },

    get licenseAccepted() {
      return licenseAccepted;
    },
    set licenseAccepted(v: boolean) {
      licenseAccepted = v;
    },

    get licenseScrolledToBottom() {
      return licenseScrolledToBottom;
    },
    set licenseScrolledToBottom(v: boolean) {
      licenseScrolledToBottom = v;
    },

    get anthropicKey() {
      return anthropicKey;
    },
    set anthropicKey(v: string) {
      anthropicKey = v;
    },

    get openaiKey() {
      return openaiKey;
    },
    set openaiKey(v: string) {
      openaiKey = v;
    },

    get downloadedBytes() {
      return downloadedBytes;
    },
    set downloadedBytes(v: number) {
      downloadedBytes = v;
    },

    get totalBytes() {
      return totalBytes;
    },
    set totalBytes(v: number) {
      totalBytes = v;
    },

    get bytesPerSec() {
      return bytesPerSec;
    },
    set bytesPerSec(v: number) {
      bytesPerSec = v;
    },

    get downloadError() {
      return downloadError;
    },
    set downloadError(v: string | null) {
      downloadError = v;
    },

    get retryAttempt() {
      return retryAttempt;
    },
    set retryAttempt(v: number) {
      retryAttempt = v;
    },

    get retryMax() {
      return retryMax;
    },
    set retryMax(v: number) {
      retryMax = v;
    },

    get retryDelaySecs() {
      return retryDelaySecs;
    },
    set retryDelaySecs(v: number) {
      retryDelaySecs = v;
    },

    get retryError() {
      return retryError;
    },
    set retryError(v: string | null) {
      retryError = v;
    },

    get isRetrying() {
      return retryAttempt > 0;
    },

    get downloadPath() {
      return downloadPath;
    },
    set downloadPath(v: string) {
      downloadPath = v;
    },

    get error() {
      return error;
    },
    set error(v: string | null) {
      error = v;
    },

    // Derived display values
    get progressPercent(): number {
      return totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
    },

    get speedStr(): string {
      return formatBytes(bytesPerSec) + "/s";
    },

    get etaStr(): string {
      if (bytesPerSec === 0 || totalBytes === 0) return "--";
      const remaining = (totalBytes - downloadedBytes) / bytesPerSec;
      return formatDuration(remaining);
    },
  };
}

export const store = createStore();
