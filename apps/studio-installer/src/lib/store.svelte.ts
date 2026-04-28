// Step enum — linear install flow
export type Step = "welcome" | "license" | "api-keys" | "download" | "extract" | "launch" | "done";

// Install mode determined at startup
export type InstallMode = "fresh" | "update" | "current";

// AI provider — drives env-var name + UX hints in the API Keys step.
export type ProviderId = "anthropic" | "openai" | "gemini" | "groq";

// Per-service health row from the launcher's /api/launcher-health
// stream. The `status` string mirrors healthsvc.go's vocabulary
// ("pending" | "starting" | "healthy" | "failed").
export type ServiceStatus = {
  name: string;
  status: "pending" | "starting" | "healthy" | "failed";
  since_secs: number;
};

// Stage of the wait-healthy step. Drives Launch.svelte UI: which
// copy to show, whether to expose Wait/View logs/Open anyway/Wait
// again buttons, and whether the "Open in Browser" CTA is enabled.
//
//   idle:          before the wait command runs (Launch step entered)
//   connecting:    Tauri command issued; SSE connect retrying
//   waiting:       SSE live; rendering checklist; under soft deadline
//   long-wait:     soft deadline (60s) elapsed; "Wait 60s more" shown
//   timeout:       hard deadline elapsed; View logs / Open anyway shown
//   unreachable:   SSE-connect deadline (20s) elapsed without a connect
//   ready:         all services healthy — "Open in Browser" enabled
//   shutting-down: launcher reported shutting_down=true mid-wait
export type LaunchStage =
  | "idle"
  | "connecting"
  | "waiting"
  | "long-wait"
  | "timeout"
  | "unreachable"
  | "ready"
  | "shutting-down";

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

  // API key — single provider chosen at install time. The full env-var name
  // (e.g. ANTHROPIC_API_KEY) is derived from `selectedProvider` at write time.
  let selectedProvider = $state<ProviderId>("anthropic");
  let apiKey = $state("");

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

  // Extract progress (Stack 2): running count of unpacked entries.
  // Total isn't known up-front because the archive's entry count
  // requires a streaming pass; UI shows "Unpacking… N files" without
  // a percentage.
  let extractEntriesDone = $state(0);

  // Wait-healthy state (Stack 2): per-service rows, stage machine,
  // elapsed timer, extension count. The launcher's stream emits a
  // full snapshot per event (not deltas), so `services` is replaced
  // wholesale on each Snapshot HealthEvent.
  let services = $state<ServiceStatus[]>([]);
  let launchStage = $state<LaunchStage>("idle");
  let waitElapsedSecs = $state(0);
  let waitDeadlineExtensions = $state(0);
  // The names of services that were NOT healthy when the hard
  // deadline fired. Drives the timeout-state messaging.
  let stuckServices = $state<string[]>([]);
  // Whether playground was healthy at the timeout — the
  // partial-success rule allows "Open anyway" iff this is true.
  let playgroundHealthyAtTimeout = $state(false);
  // Free-form reason from a HealthEvent::Unreachable. Surfaced in
  // the unreachable-stage UI alongside View logs.
  let launchUnreachableReason = $state<string | null>(null);

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

    get selectedProvider() {
      return selectedProvider;
    },
    set selectedProvider(v: ProviderId) {
      selectedProvider = v;
    },

    get apiKey() {
      return apiKey;
    },
    set apiKey(v: string) {
      apiKey = v;
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

    // Stack 2 — extract progress (running count, no total).
    get extractEntriesDone(): number {
      return extractEntriesDone;
    },
    set extractEntriesDone(v: number) {
      extractEntriesDone = v;
    },

    // Stack 2 — wait-healthy state.
    get services(): ServiceStatus[] {
      return services;
    },
    set services(v: ServiceStatus[]) {
      services = v;
    },
    get launchStage(): LaunchStage {
      return launchStage;
    },
    set launchStage(v: LaunchStage) {
      launchStage = v;
    },
    get waitElapsedSecs(): number {
      return waitElapsedSecs;
    },
    set waitElapsedSecs(v: number) {
      waitElapsedSecs = v;
    },
    get waitDeadlineExtensions(): number {
      return waitDeadlineExtensions;
    },
    set waitDeadlineExtensions(v: number) {
      waitDeadlineExtensions = v;
    },
    get stuckServices(): string[] {
      return stuckServices;
    },
    set stuckServices(v: string[]) {
      stuckServices = v;
    },
    get playgroundHealthyAtTimeout(): boolean {
      return playgroundHealthyAtTimeout;
    },
    set playgroundHealthyAtTimeout(v: boolean) {
      playgroundHealthyAtTimeout = v;
    },
    get launchUnreachableReason(): string | null {
      return launchUnreachableReason;
    },
    set launchUnreachableReason(v: string | null) {
      launchUnreachableReason = v;
    },

    // Derived: are all known services healthy? Used by Launch.svelte
    // to gate the "Open in Browser" CTA. False when services is
    // empty (no first event yet) — matches HealthCache.AllHealthy.
    get allServicesHealthy(): boolean {
      if (services.length === 0) return false;
      return services.every((s) => s.status === "healthy");
    },
  };
}

export const store = createStore();
