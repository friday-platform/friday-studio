<!--
  Settings — Models (with primary → fallback chain) + collapsible env vars.

  The models section renders a per-role card:
    - left column: role name, description
    - right column: <ModelChain> primary slot + up to 3 fallback slots
      (draggable to reorder, "+ Add fallback" button below)

  Clicking a slot opens <ModelPicker> — a modal flyout with provider
  pills, search, and an inline "Save & unlock" flow for locked providers
  that writes directly to the daemon's .env file (resolved server-side
  via getFridayHome — `~/.friday/local/.env` under the Studio launcher,
  `~/.atlas/.env` for manual / dev runs) without leaving the modal.

  Save button at the bottom PUTs `/api/config/models` with chains; the
  daemon validates each entry via `createPlatformModels` before writing
  friday.yml. Restart required for changes to take effect — banner
  reminds the user after a successful save.

  @component
-->
<script lang="ts">
  import { Button, PageLayout, toast } from "@atlas/ui";
  import ModelChain from "$lib/components/settings/model-chain.svelte";
  import ModelPicker from "$lib/components/settings/model-picker.svelte";
  import { externalTunnelUrl } from "$lib/daemon-url";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { workspaceQueries } from "$lib/queries";
  import { z } from "zod";

  const TunnelStatusSchema = z.object({ url: z.string().nullable() });

  // ─── Types mirroring the daemon's route shapes ─────────────────────

  type ModelRole = "labels" | "classifier" | "planner" | "conversational";

  interface EnvRow {
    key: string;
    value: string;
  }

  interface ModelChoice {
    provider: string;
    modelId: string;
  }

  interface ModelInfo {
    role: ModelRole;
    resolved: { provider: string; modelId: string };
    /** Raw friday.yml value. string = primary only; string[] = chain;
     * null = use defaults. */
    configured: string | string[] | null;
  }

  interface CatalogModel {
    id: string;
    displayName: string;
  }
  interface ProviderMeta {
    name: string;
    letter: string;
    keyPrefix: string | null;
    helpUrl: string | null;
  }
  interface CatalogEntry {
    provider: string;
    credentialConfigured: boolean;
    credentialEnvVar: string | null;
    meta: ProviderMeta;
    models: CatalogModel[];
    error?: string;
  }

  interface PickerState {
    roleIdx: number;
    slotIdx: number;
    /** True when the user clicked "Add fallback" — the picker inserts a
     * new slot on select rather than replacing an existing one. */
    adding: boolean;
  }

  const ROLES: readonly ModelRole[] = [
    "conversational",
    "planner",
    "classifier",
    "labels",
  ] as const;

  const ROLE_DESCRIPTIONS: Record<ModelRole, string> = {
    labels: "Short text generation — session titles, progress strings.",
    classifier: "Structured output decisions — triage, routing.",
    planner: "Multi-step synthesis with tool calls — workflow planning.",
    conversational: "Streaming chat with tools and multi-turn memory.",
  };

  const ROLE_TITLES: Record<ModelRole, string> = {
    labels: "Labels",
    classifier: "Classifier",
    planner: "Planner",
    conversational: "Conversational",
  };

  /**
   * Parse a raw `configured` value from `/api/config/models` into our
   * internal chain representation. A bare string becomes a single-item
   * chain; an array passes through; `null` (no override) becomes an
   * empty chain, which the UI renders as "using defaults".
   */
  function parseChain(raw: string | string[] | null): ModelChoice[] {
    if (raw === null) return [];
    const arr = Array.isArray(raw) ? raw : [raw];
    const out: ModelChoice[] = [];
    for (const entry of arr) {
      const idx = entry.indexOf(":");
      if (idx <= 0) continue; // malformed — drop silently
      out.push({ provider: entry.slice(0, idx), modelId: entry.slice(idx + 1) });
    }
    return out;
  }

  function serializeChain(chain: ModelChoice[]): string | string[] | null {
    if (chain.length === 0) return null;
    const encoded = chain.map((c) => `${c.provider}:${c.modelId}`);
    return encoded.length === 1 ? encoded[0] : encoded;
  }

  // ─── State ─────────────────────────────────────────────────────────

  let envRows = $state<EnvRow[]>([]);
  // Resolved server-side via getFridayHome() — `~/.friday/local/.env` under the
  // Studio launcher (FRIDAY_HOME set), `~/.atlas/.env` for manual / dev runs.
  // Surfaced in the UI so the labels match the file actually being read/written.
  let envPath = $state<string | null>(null);
  let models = $state<ModelInfo[]>([]);
  let catalog = $state<CatalogEntry[]>([]);
  // Per-role editable chain. Reflects the user's in-flight edits; flushed
  // to friday.yml on Save.
  let chains = $state<Record<ModelRole, ModelChoice[]>>({
    labels: [],
    classifier: [],
    planner: [],
    conversational: [],
  });
  let picker = $state<PickerState | null>(null);
  let dirty = $state(false);
  let loadingEnv = $state(true);
  let loadingModels = $state(true);
  let loadingCatalog = $state(true);
  let savingEnv = $state(false);
  let savingModels = $state(false);
  let envError = $state<string | null>(null);
  let modelsError = $state<string | null>(null);
  let catalogError = $state<string | null>(null);
  let successFlash = $state<string | null>(null);

  const queryClient = useQueryClient();

  // ─── Tunnel state ──────────────────────────────────────────────────

  let tunnelUrl = $state<string | null>(null);
  let tunnelLoading = $state(true);
  let tunnelError = $state<string | null>(null);

  async function loadTunnel(): Promise<void> {
    tunnelLoading = true;
    tunnelError = null;
    try {
      const res = await fetch(`${externalTunnelUrl()}/status`);
      if (!res.ok) {
        tunnelError = `Tunnel unreachable (HTTP ${res.status})`;
        return;
      }
      const parsed = TunnelStatusSchema.safeParse(await res.json());
      if (parsed.success) {
        tunnelUrl = parsed.data.url;
      } else {
        tunnelError = "Tunnel response did not match expected shape";
      }
    } catch (err) {
      tunnelError = err instanceof Error ? err.message : String(err);
    } finally {
      tunnelLoading = false;
    }
  }

  function copyTunnelUrl(): void {
    if (!tunnelUrl) return;
    if (navigator.clipboard) {
      navigator.clipboard
        .writeText(tunnelUrl)
        .then(() => toast({ title: "Tunnel URL copied" }))
        .catch(() => toast({ title: "Copy failed", error: true }));
    }
  }

  // ─── Loaders ───────────────────────────────────────────────────────

  async function loadEnv(): Promise<EnvRow[]> {
    loadingEnv = true;
    envError = null;
    try {
      const res = await fetch("/api/daemon/api/config/env");
      if (!res.ok) {
        envError = `Failed to load env (HTTP ${res.status})`;
        return [];
      }
      const data: unknown = await res.json();
      if (typeof data === "object" && data !== null && "envPath" in data) {
        const rawPath = (data as { envPath: unknown }).envPath;
        envPath = typeof rawPath === "string" ? rawPath : null;
      }
      if (
        typeof data === "object" &&
        data !== null &&
        "envVars" in data &&
        typeof (data as { envVars: unknown }).envVars === "object" &&
        (data as { envVars: unknown }).envVars !== null
      ) {
        const rows = Object.entries((data as { envVars: Record<string, unknown> }).envVars)
          .map(([key, value]) => ({ key, value: String(value ?? "") }))
          .sort((a, b) => a.key.localeCompare(b.key));
        envRows = rows;
        return rows;
      }
      envRows = [];
      return [];
    } catch (err) {
      envError = err instanceof Error ? err.message : String(err);
      return [];
    } finally {
      loadingEnv = false;
    }
  }

  async function loadModels(): Promise<void> {
    loadingModels = true;
    modelsError = null;
    try {
      const res = await fetch("/api/daemon/api/config/models");
      if (!res.ok) {
        modelsError = `Failed to load models (HTTP ${res.status})`;
        return;
      }
      const data: unknown = await res.json();
      if (
        typeof data === "object" &&
        data !== null &&
        "models" in data &&
        Array.isArray((data as { models: unknown }).models)
      ) {
        const fetched = (data as { models: ModelInfo[] }).models;
        models = [...fetched].sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
        const nextChains: Record<ModelRole, ModelChoice[]> = {
          labels: [],
          classifier: [],
          planner: [],
          conversational: [],
        };
        for (const m of models) {
          nextChains[m.role] = parseChain(m.configured);
        }
        chains = nextChains;
        // Server state is authoritative; any in-flight edits are now
        // reset. Flipping dirty off reflects that.
        dirty = false;
      }
    } catch (err) {
      modelsError = err instanceof Error ? err.message : String(err);
    } finally {
      loadingModels = false;
    }
  }

  async function loadCatalog(): Promise<void> {
    loadingCatalog = true;
    catalogError = null;
    try {
      const res = await fetch("/api/daemon/api/config/models/catalog");
      if (!res.ok) {
        catalogError = `Failed to load catalog (HTTP ${res.status})`;
        return;
      }
      const data: unknown = await res.json();
      if (
        typeof data === "object" &&
        data !== null &&
        "entries" in data &&
        Array.isArray((data as { entries: unknown }).entries)
      ) {
        catalog = (data as { entries: CatalogEntry[] }).entries;
      }
    } catch (err) {
      catalogError = err instanceof Error ? err.message : String(err);
    } finally {
      loadingCatalog = false;
    }
  }

  // ─── Chain mutations ───────────────────────────────────────────────

  function updateChain(role: ModelRole, next: ModelChoice[]): void {
    chains = { ...chains, [role]: next };
    dirty = true;
    successFlash = null;
  }

  function handleEditSlot(role: ModelRole, slotIdx: number): void {
    const roleIdx = ROLES.indexOf(role);
    picker = { roleIdx, slotIdx, adding: false };
  }

  function handleRemoveSlot(role: ModelRole, slotIdx: number): void {
    const current = chains[role];
    // Slot 0 is primary — remove-slot is only wired for fallbacks, but
    // guard here too so we can't accidentally drop the primary.
    if (slotIdx === 0) return;
    const next = current.filter((_, i) => i !== slotIdx);
    updateChain(role, next);
  }

  function handleReorder(role: ModelRole, from: number, to: number): void {
    const current = chains[role].slice();
    if (from < 0 || from >= current.length || to < 0 || to >= current.length) return;
    const [moved] = current.splice(from, 1);
    if (moved) current.splice(to, 0, moved);
    updateChain(role, current);
  }

  /**
   * The daemon reports `resolved.provider` in its LiteLLM-style registry
   * form (e.g. `groq.chat`, `anthropic.messages`) — that's what the AI
   * SDK surfaces off the LanguageModelV3. friday.yml and the catalog
   * both speak the short form (`groq`, `anthropic`), so translate by
   * stripping anything after the first dot. Verify the short form is an
   * actual catalog provider before we promote — if it isn't (custom
   * registry, unusual alias) we fall back to the explicit Override path
   * so we can't accidentally serialize a bogus primary.
   */
  function toShortProvider(registryProvider: string): string | null {
    const candidate = registryProvider.split(".")[0];
    if (!candidate) return null;
    if (catalog.some((e) => e.provider === candidate)) return candidate;
    return null;
  }

  /**
   * Add a fallback slot. Two entry paths:
   *
   *   1. Chain is non-empty → open picker for slot = chain.length, adding
   *      mode. User picks a fallback, it appends to the chain.
   *
   *   2. Chain is empty (role is using defaults) → promote the daemon's
   *      resolved model into slot 0 as an explicit primary, then open the
   *      picker for the new slot 1. Net effect: "defaults + my fallback"
   *      becomes an explicit two-entry chain where the primary mirrors
   *      whatever was default at save time. User can change the primary
   *      later by clicking its tile.
   *
   *      Edge case: if we can't translate `resolved.provider` to a known
   *      catalog provider (unusual), we take the safer Override route
   *      (picker for slot 0, empty chain) so the user picks their own
   *      primary instead of getting a broken chain written to friday.yml.
   */
  function handleAddFallback(role: ModelRole): void {
    const roleIdx = ROLES.indexOf(role);
    const current = chains[role];

    if (current.length > 0) {
      picker = { roleIdx, slotIdx: current.length, adding: true };
      return;
    }

    const modelInfo = models.find((m) => m.role === role);
    if (!modelInfo) {
      picker = { roleIdx, slotIdx: 0, adding: true };
      return;
    }
    const shortProvider = toShortProvider(modelInfo.resolved.provider);
    if (!shortProvider) {
      // Couldn't translate the resolved provider — fall back to the
      // Override flow so the user picks an explicit primary instead of
      // us writing something wrong.
      picker = { roleIdx, slotIdx: 0, adding: true };
      return;
    }

    // Pin the currently-resolved default as the explicit primary, then
    // open the picker for the new fallback slot. Parent state picks up
    // the dirty flag via updateChain.
    updateChain(role, [{ provider: shortProvider, modelId: modelInfo.resolved.modelId }]);
    picker = { roleIdx, slotIdx: 1, adding: true };
  }

  function handleOverrideDefault(role: ModelRole): void {
    // "Override" is only visible when the chain is empty. We open the
    // picker for slot 0 (primary) in add mode so selecting a model
    // creates the first entry of an explicit chain.
    const roleIdx = ROLES.indexOf(role);
    picker = { roleIdx, slotIdx: 0, adding: true };
  }

  function handlePickerSelect(choice: ModelChoice | null): void {
    if (!picker) return;
    const role = ROLES[picker.roleIdx];
    if (!role) return;

    if (choice === null) {
      // "Use default chain" — clear the entire override for this role.
      updateChain(role, []);
    } else {
      const next = chains[role].slice();
      if (picker.adding) {
        next.splice(picker.slotIdx, 0, choice);
      } else {
        next[picker.slotIdx] = choice;
      }
      updateChain(role, next);
    }
    picker = null;
  }

  // ─── Save-key (inline unlock) ──────────────────────────────────────

  /**
   * Inline API-key save from the picker's locked-provider banner. Reads
   * current .env, splices in the new key, PUTs the full map. Returns
   * the updated catalog (with the newly-unlocked provider flipped) so
   * the picker re-renders its pills immediately.
   */
  async function handleSaveApiKey(envVar: string, value: string): Promise<CatalogEntry[] | null> {
    // Refresh rows so we don't clobber concurrent edits from another
    // tab — the .env endpoint is full-rewrite, so staleness would be
    // destructive.
    const latest = await loadEnv();
    const byKey = new Map(latest.map((r) => [r.key, r.value]));
    byKey.set(envVar, value);
    const payload = Object.fromEntries(byKey);

    const putRes = await fetch("/api/daemon/api/config/env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envVars: payload }),
    });
    if (!putRes.ok) {
      const text = await putRes.text();
      throw new Error(`Save failed (HTTP ${putRes.status}): ${text}`);
    }

    const savedTo = envPath ?? "the daemon's .env file";
    successFlash = `Saved ${envVar} to ${savedTo}. Restart the daemon to apply.`;
    setTimeout(() => {
      if (successFlash && successFlash.includes(envVar)) successFlash = null;
    }, 4000);

    // Reload the catalog so the provider we just unlocked flips to
    // credentialConfigured: true. Also pull env rows in sync.
    await Promise.all([loadCatalog(), loadEnv()]);
    return catalog;
  }

  // ─── Save models + discard ─────────────────────────────────────────

  async function handleSaveModels(): Promise<void> {
    savingModels = true;
    modelsError = null;
    successFlash = null;
    try {
      const payload: Record<ModelRole, string | string[] | null> = {
        labels: serializeChain(chains.labels),
        classifier: serializeChain(chains.classifier),
        planner: serializeChain(chains.planner),
        conversational: serializeChain(chains.conversational),
      };
      const res = await fetch("/api/daemon/api/config/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: payload }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : `HTTP ${res.status}`;
        modelsError = msg;
        return;
      }
      successFlash = "Saved to friday.yml. Restart the daemon to apply.";
      setTimeout(() => {
        successFlash = null;
      }, 4000);
      await loadModels();
    } catch (err) {
      modelsError = err instanceof Error ? err.message : String(err);
    } finally {
      savingModels = false;
    }
  }

  function handleDiscard(): void {
    // Re-derive chains from the last-loaded `models` response.
    const next: Record<ModelRole, ModelChoice[]> = {
      labels: [],
      classifier: [],
      planner: [],
      conversational: [],
    };
    for (const m of models) next[m.role] = parseChain(m.configured);
    chains = next;
    dirty = false;
    successFlash = null;
  }

  // ─── Env vars section ──────────────────────────────────────────────

  async function saveEnv(): Promise<void> {
    savingEnv = true;
    envError = null;
    successFlash = null;
    try {
      const payload: Record<string, string> = {};
      for (const row of envRows) {
        const k = row.key.trim();
        if (k.length === 0) continue;
        payload[k] = row.value;
      }
      const res = await fetch("/api/daemon/api/config/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envVars: payload }),
      });
      if (!res.ok) {
        const text = await res.text();
        envError = `Save failed (HTTP ${res.status}): ${text}`;
        return;
      }
      successFlash = "Environment saved. Restart the daemon to apply.";
      setTimeout(() => {
        if (successFlash && successFlash.includes("Environment saved")) successFlash = null;
      }, 4000);
    } catch (err) {
      envError = err instanceof Error ? err.message : String(err);
    } finally {
      savingEnv = false;
    }
  }

  function addEnvRow(): void {
    envRows = [...envRows, { key: "", value: "" }];
  }

  function removeEnvRow(index: number): void {
    envRows = envRows.filter((_, i) => i !== index);
  }

  function isSecretKey(k: string): boolean {
    const upper = k.toUpperCase();
    return (
      upper.includes("KEY") ||
      upper.includes("TOKEN") ||
      upper.includes("SECRET") ||
      upper.includes("PASSWORD")
    );
  }

  // ─── Derived ───────────────────────────────────────────────────────

  const totalModelCount = $derived(
    catalog.reduce((n, e) => n + (e.credentialConfigured ? e.models.length : 0), 0),
  );
  const connectedProviders = $derived(catalog.filter((e) => e.credentialConfigured).length);

  const pickerRole = $derived(picker ? ROLES[picker.roleIdx] : null);
  const pickerCurrent = $derived.by<ModelChoice | null>(() => {
    if (!picker || !pickerRole) return null;
    if (picker.adding) return null;
    return chains[pickerRole][picker.slotIdx] ?? null;
  });
  const pickerSlotLabel = $derived(
    picker ? (picker.slotIdx === 0 ? "primary" : `fallback ${picker.slotIdx}`) : "",
  );
  // Allow the picker to surface "Use default chain" only when the user
  // is editing primary and the chain would become empty after that —
  // i.e. the user is still on slot 0 with no fallbacks yet. In adding
  // mode the intent is concrete, not "revert to defaults".
  const pickerAllowDefault = $derived.by(() => {
    if (!picker || !pickerRole) return false;
    if (picker.adding) return false;
    return picker.slotIdx === 0 && chains[pickerRole].length === 1;
  });

  // ─── Boot ──────────────────────────────────────────────────────────

  $effect(() => {
    void (async () => {
      await loadEnv();
      await Promise.all([loadModels(), loadCatalog(), loadTunnel()]);
    })();
  });

  // ─── Backup & restore ──────────────────────────────────────────────
  //
  // Export: GET /api/workspaces/bundle-all[?mode=migration&include=global-skills]
  // Import workspace (single): POST /api/workspaces/import-bundle
  // Import full archive:       POST /api/workspaces/import-bundle-all
  //
  // Daemon filters virtual/kernel workspaces (system) server-side — no
  // client-side filtering needed.

  interface ImportedEntry {
    workspaceId?: string;
    name?: string;
    path?: string;
    memory?: { kind: string; path?: string; reason?: string };
  }

  interface ImportSummary {
    ok: boolean;
    imported: ImportedEntry[];
    errors: { name?: string; error?: string }[];
    globalSkills?: { kind?: string } | null;
    raw?: unknown;
    message?: string;
  }

  let includeMemory = $state(false);
  let includeGlobalSkills = $state(false);
  let exporting = $state(false);

  let singleFileEl: HTMLInputElement | null = $state(null);
  let singleBusy = $state(false);
  let singleResult = $state<ImportSummary | null>(null);

  let fullFileEl: HTMLInputElement | null = $state(null);
  let fullBusy = $state(false);
  let fullResult = $state<ImportSummary | null>(null);

  async function handleExportAll() {
    if (exporting) return;
    exporting = true;
    try {
      const params = new URLSearchParams();
      if (includeMemory) params.set("mode", "migration");
      if (includeGlobalSkills) params.set("include", "global-skills");
      const qs = params.toString();
      const url = `/api/daemon/api/workspaces/bundle-all${qs ? `?${qs}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text();
        toast({ title: `Export failed: ${body.slice(0, 200)}`, error: true });
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const nameMatch = /filename="([^"]+)"/.exec(disposition);
      const filename = nameMatch?.[1] ?? `atlas-full-export.zip`;
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(href);
      const bundled = res.headers.get("x-atlas-bundled-workspaces") ?? "?";
      toast({ title: `Downloaded ${bundled} workspace(s)` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: `Export failed: ${msg}`, error: true });
    } finally {
      exporting = false;
    }
  }

  async function postBundle(url: string, file: File): Promise<ImportSummary> {
    const form = new FormData();
    form.set("bundle", file);
    const res = await fetch(url, { method: "POST", body: form });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        imported: [],
        errors: [],
        message: typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
        raw: body,
      };
    }
    return {
      ok: true,
      imported: Array.isArray(body.imported)
        ? (body.imported as ImportedEntry[])
        : body.workspaceId
          ? [
              {
                workspaceId: String(body.workspaceId),
                name: typeof body.name === "string" ? body.name : undefined,
                path: typeof body.path === "string" ? body.path : undefined,
                memory:
                  body.memory && typeof body.memory === "object"
                    ? (body.memory as ImportedEntry["memory"])
                    : undefined,
              },
            ]
          : [],
      errors: Array.isArray(body.errors)
        ? (body.errors as { name?: string; error?: string }[])
        : [],
      globalSkills: (body.globalSkills as { kind?: string } | null | undefined) ?? null,
      raw: body,
    };
  }

  async function handleImportSingle() {
    const file = singleFileEl?.files?.[0];
    if (!file || singleBusy) return;
    singleBusy = true;
    singleResult = null;
    try {
      singleResult = await postBundle("/api/daemon/api/workspaces/import-bundle", file);
      if (singleResult.ok) {
        await queryClient.invalidateQueries({ queryKey: workspaceQueries.all() });
        toast({ title: `Imported: ${singleResult.imported[0]?.name ?? "workspace"}` });
      } else {
        toast({ title: singleResult.message ?? "Import failed", error: true });
      }
    } finally {
      singleBusy = false;
    }
  }

  async function handleImportFull() {
    const file = fullFileEl?.files?.[0];
    if (!file || fullBusy) return;
    fullBusy = true;
    fullResult = null;
    try {
      fullResult = await postBundle("/api/daemon/api/workspaces/import-bundle-all", file);
      if (fullResult.ok) {
        await queryClient.invalidateQueries({ queryKey: workspaceQueries.all() });
        const n = fullResult.imported.length;
        const errs = fullResult.errors.length;
        toast({ title: `Imported ${n} workspace(s)${errs ? ` — ${errs} error(s)` : ""}` });
      } else {
        toast({ title: fullResult.message ?? "Import failed", error: true });
      }
    } finally {
      fullBusy = false;
    }
  }

  /** Translate a raw server status into a human-readable phrase. `null` means
   * "nothing worth showing". Kept inside this component since the raw strings
   * are a private protocol between the daemon and this UI. */
  function memoryLabel(kind: string | undefined): string | null {
    if (kind === "moved") return "notes imported";
    if (kind === "sideloaded") return "notes saved separately — existing data preserved";
    return null;
  }

  function globalSkillsLabel(kind: string | undefined): string | null {
    if (kind === "imported") return "skills library imported";
    if (kind === "skipped-existing")
      return "skills library saved separately — existing library preserved";
    if (kind === "integrity-failed") return "skills library failed integrity check";
    return null;
  }
</script>

<PageLayout.Root>
  <PageLayout.Title>Settings</PageLayout.Title>
  <PageLayout.Body>
    <PageLayout.Content>
      <div class="settings-root">
        <!-- ─── Models section ────────────────────────────────────────── -->
        <section class="section">
          <div class="section-header-row">
            <div class="section-header">
              <h2>Models</h2>
              <p class="section-sub">
                Per-role routing with an ordered fallback chain. The daemon tries the primary, then
                each fallback in turn. Format stored as <code>provider:model</code>
                in
                <code>friday.yml</code>
                .
              </p>
            </div>
            <div class="section-meta">
              {totalModelCount} models · {connectedProviders}/{catalog.length} connected
            </div>
          </div>

          {#if loadingModels || loadingCatalog}
            <div class="loading">Loading models…</div>
          {:else if modelsError}
            <div class="error-banner" role="alert">
              <pre class="error-text">{modelsError}</pre>
              <button class="dismiss" onclick={() => (modelsError = null)}>Dismiss</button>
            </div>
          {:else}
            {#if catalogError}
              <div class="warn-banner">
                Catalog load failed: {catalogError}. You can still pick from resolved providers.
              </div>
            {/if}

            <div class="roles-grid">
              {#each models as m (m.role)}
                <div class="role-card">
                  <div class="role-head">
                    <span class="role-name-upper">{m.role}</span>
                    <span class="role-name">{ROLE_TITLES[m.role]}</span>
                    <p class="role-desc">{ROLE_DESCRIPTIONS[m.role]}</p>
                  </div>
                  <ModelChain
                    role={m.role}
                    chain={chains[m.role]}
                    resolved={m.resolved}
                    {catalog}
                    onEditSlot={(slotIdx) => handleEditSlot(m.role, slotIdx)}
                    onRemoveSlot={(slotIdx) => handleRemoveSlot(m.role, slotIdx)}
                    onReorder={(from, to) => handleReorder(m.role, from, to)}
                    onAddFallback={() => handleAddFallback(m.role)}
                    onOverrideDefault={() => handleOverrideDefault(m.role)}
                  />
                </div>
              {/each}
            </div>

            <div class="actions">
              {#if dirty}
                <span class="unsaved-indicator">Unsaved changes</span>
              {:else if successFlash}
                <span class="success-flash">{successFlash}</span>
              {/if}
              <Button variant="secondary" onclick={handleDiscard} disabled={!dirty || savingModels}>
                Discard
              </Button>
              <Button
                variant="primary"
                onclick={handleSaveModels}
                disabled={!dirty || savingModels}
              >
                {savingModels ? "Saving…" : "Save models"}
              </Button>
            </div>
          {/if}
        </section>

        <!-- ─── Tunnel section ─────────────────────────────────────── -->
        <section class="section">
          <div class="section-header-row">
            <div class="section-header">
              <h2>Webhook tunnel</h2>
              <p class="section-sub">
                Public URL of the local Cloudflare tunnel (
                <code>webhook-tunnel</code>
                ). Use it as the base for inbound webhooks.
              </p>
            </div>
            <div class="section-meta">
              {tunnelLoading ? "…" : tunnelUrl ? "active" : "inactive"}
            </div>
          </div>

          {#if tunnelLoading}
            <div class="loading">Checking tunnel…</div>
          {:else if tunnelUrl}
            <div class="tunnel-row">
              <code class="tunnel-url">{tunnelUrl}</code>
              <Button variant="secondary" onclick={copyTunnelUrl}>Copy</Button>
            </div>
          {:else}
            <div class="warn-banner">
              {tunnelError ?? "No tunnel URL available — webhook-tunnel may not be running."}
            </div>
          {/if}
        </section>

        <!-- ─── Env vars section ───────────────────────────────────── -->
        <section class="section">
          <details class="env-details">
            <summary class="env-summary">
              <span class="section-h">Environment variables</span>
              <span class="env-count">
                {loadingEnv ? "…" : `${envRows.length} keys`}
              </span>
            </summary>

            <div class="env-body">
              <p class="section-sub">
                From <code>{envPath ?? "the daemon's .env file"}</code>
                . Secrets (
                <em>KEY</em>
                ,
                <em>TOKEN</em>
                ,
                <em>SECRET</em>
                ,
                <em>PASSWORD</em>
                ) render as password inputs.
              </p>

              {#if loadingEnv}
                <div class="loading">Loading environment…</div>
              {:else if envError}
                <div class="error-banner" role="alert">
                  <span>{envError}</span>
                  <button class="dismiss" onclick={() => loadEnv()}>Retry</button>
                </div>
              {:else}
                <div class="env-table">
                  <div class="env-table-header">
                    <span class="col-key">Key</span>
                    <span class="col-value">Value</span>
                    <span class="col-action"></span>
                  </div>
                  {#each envRows as row, i (i)}
                    <div class="env-row">
                      <input
                        class="col-key"
                        type="text"
                        bind:value={row.key}
                        placeholder="VARIABLE_NAME"
                        autocomplete="off"
                        spellcheck="false"
                      />
                      <input
                        class="col-value"
                        type={isSecretKey(row.key) ? "password" : "text"}
                        bind:value={row.value}
                        placeholder="value"
                        autocomplete="off"
                        spellcheck="false"
                      />
                      <button
                        class="col-action remove"
                        onclick={() => removeEnvRow(i)}
                        aria-label="Remove row"
                      >
                        ✕
                      </button>
                    </div>
                  {/each}
                  {#if envRows.length === 0}
                    <div class="empty">No settings yet. Add one below.</div>
                  {/if}
                </div>

                <div class="actions">
                  <Button variant="secondary" onclick={addEnvRow} disabled={savingEnv}>
                    Add variable
                  </Button>
                  <Button variant="primary" onclick={saveEnv} disabled={savingEnv}>
                    {savingEnv ? "Saving…" : "Save"}
                  </Button>
                </div>
              {/if}
            </div>
          </details>
        </section>

        <!-- ─── Backup & restore section ─────────────────────────────── -->
        <section class="section">
          <div class="section-header-row">
            <div class="section-header">
              <h2>Backup &amp; restore</h2>
              <p class="section-sub">
                Export your workspaces as a portable zip, and re-import them on another machine.
                Imports never overwrite existing data — if a conflict is detected, the incoming copy
                lands next to the existing one so you can merge manually.
              </p>
            </div>
          </div>

          <div class="backup-grid">
            <!-- Export -->
            <div class="backup-card">
              <h3 class="backup-h">Export all workspaces</h3>
              <p class="backup-sub">
                Download every workspace as a single zip you can import on another machine.
              </p>
              <label class="backup-check">
                <input type="checkbox" bind:checked={includeMemory} />
                <span>Include notes &amp; memory</span>
              </label>
              <label class="backup-check">
                <input type="checkbox" bind:checked={includeGlobalSkills} />
                <span>Include your skills library</span>
              </label>
              <div class="backup-actions">
                <Button onclick={handleExportAll} disabled={exporting}>
                  {exporting ? "Building…" : "Download full export"}
                </Button>
              </div>
            </div>

            <!-- Import single -->
            <div class="backup-card">
              <h3 class="backup-h">Import a workspace</h3>
              <p class="backup-sub">
                Pick a zip downloaded from a single workspace. It becomes a new workspace here.
              </p>
              <input
                bind:this={singleFileEl}
                type="file"
                accept=".zip,application/zip"
                class="backup-file"
              />
              <div class="backup-actions">
                <Button onclick={handleImportSingle} disabled={singleBusy}>
                  {singleBusy ? "Importing…" : "Import workspace"}
                </Button>
              </div>
              {#if singleResult}
                <div class="backup-result" class:err={!singleResult.ok}>
                  {#if singleResult.ok}
                    <div>
                      Imported: <strong>{singleResult.imported[0]?.name ?? "?"}</strong>
                    </div>
                    {#if memoryLabel(singleResult.imported[0]?.memory?.kind)}
                      <div class="muted">{memoryLabel(singleResult.imported[0]?.memory?.kind)}</div>
                    {/if}
                  {:else}
                    {singleResult.message ?? "Failed"}
                  {/if}
                </div>
              {/if}
            </div>

            <!-- Import full archive -->
            <div class="backup-card">
              <h3 class="backup-h">Import a full archive</h3>
              <p class="backup-sub">
                Pick a full-export zip. Every workspace inside gets imported, along with any skills
                library or memory the archive carried.
              </p>
              <input
                bind:this={fullFileEl}
                type="file"
                accept=".zip,application/zip"
                class="backup-file"
              />
              <div class="backup-actions">
                <Button onclick={handleImportFull} disabled={fullBusy}>
                  {fullBusy ? "Importing…" : "Import full archive"}
                </Button>
              </div>
              {#if fullResult}
                <div class="backup-result" class:err={!fullResult.ok}>
                  {#if fullResult.ok}
                    <div>
                      <strong>{fullResult.imported.length}</strong>
                      workspace(s) imported
                    </div>
                    {#if fullResult.imported.length > 0}
                      <ul class="backup-list">
                        {#each fullResult.imported as entry, i (i)}
                          <li>
                            <strong>{entry.name ?? "?"}</strong>
                            {#if memoryLabel(entry.memory?.kind)}
                              <span class="muted">— {memoryLabel(entry.memory?.kind)}</span>
                            {/if}
                          </li>
                        {/each}
                      </ul>
                    {/if}
                    {#if globalSkillsLabel(fullResult.globalSkills?.kind)}
                      <div class="muted">
                        {globalSkillsLabel(fullResult.globalSkills?.kind)}
                      </div>
                    {/if}
                    {#if fullResult.errors.length > 0}
                      <div class="backup-errors">
                        <strong>{fullResult.errors.length} error(s):</strong>
                        <ul class="backup-list">
                          {#each fullResult.errors as e, i (i)}
                            <li>
                              <strong>{e.name ?? "?"}</strong>
                              : {e.error ?? "?"}
                            </li>
                          {/each}
                        </ul>
                      </div>
                    {/if}
                  {:else}
                    {fullResult.message ?? "Failed"}
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        </section>
      </div>
    </PageLayout.Content>
    <PageLayout.Sidebar>
      <p class="subtitle">
        Settings are resolved at daemon startup. Per-role models come from
        <code>friday.yml</code>
        ; environment variables come from
        <code>{envPath ?? "the daemon's .env file"}</code>
        . Both take effect on the next daemon restart.
      </p>
    </PageLayout.Sidebar>
  </PageLayout.Body>
</PageLayout.Root>

{#if picker && pickerRole}
  <ModelPicker
    roleTitle={ROLE_TITLES[pickerRole]}
    slotLabel={pickerSlotLabel}
    current={pickerCurrent}
    allowDefault={pickerAllowDefault}
    {catalog}
    saveApiKey={handleSaveApiKey}
    onSelect={handlePickerSelect}
    onClose={() => (picker = null)}
  />
{/if}

<style>
  .settings-root {
    display: flex;
    flex-direction: column;
    gap: 28px;
  }

  .subtitle,
  .section-sub {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: 13px;
    line-height: 1.55;
    margin: 0;
    max-width: 64ch;
  }

  .subtitle code,
  .section-sub code {
    background: var(--color-surface-3);
    border-radius: 4px;
    font-size: 12px;
    padding: 1px 6px;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .section-header-row {
    align-items: baseline;
    display: flex;
    gap: 12px;
    justify-content: space-between;
  }

  .section-header {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .section-header h2 {
    font-size: 21px;
    font-weight: 600;
    letter-spacing: -0.005em;
    margin: 0;
  }

  .section-meta {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-family: var(--font-family-monospace);
    font-size: 12px;
    white-space: nowrap;
  }

  .roles-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: 1fr;
  }

  .role-card {
    align-items: start;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: 10px;
    display: grid;
    gap: 20px;
    grid-template-columns: 200px 1fr;
    padding: 16px 20px;
    transition: border-color 120ms ease;
  }
  .role-card:hover {
    border-color: var(--color-border-2);
  }

  .role-head {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .role-name-upper {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .role-name {
    color: var(--color-text);
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .role-desc {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
    max-width: 28ch;
  }

  .actions {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 12px;
  }

  .unsaved-indicator {
    align-items: center;
    color: var(--color-warning);
    display: inline-flex;
    font-family: var(--font-family-monospace);
    font-size: 12px;
    gap: 6px;
    margin-right: auto;
  }
  .unsaved-indicator::before {
    background: var(--color-warning);
    border-radius: 50%;
    content: "";
    height: 6px;
    width: 6px;
  }
  .success-flash {
    color: var(--color-success);
    font-family: var(--font-family-monospace);
    font-size: 12px;
    margin-right: auto;
  }

  .loading,
  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-size: 13px;
    padding: 16px;
    text-align: center;
  }

  .error-banner {
    align-items: center;
    background: color-mix(in srgb, var(--color-error), transparent 85%);
    border: 1px solid color-mix(in srgb, var(--color-error), transparent 50%);
    border-radius: 6px;
    display: flex;
    gap: 12px;
    padding: 10px 14px;
  }
  .error-text {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: 12px;
    margin: 0;
    white-space: pre-wrap;
  }
  .dismiss {
    background: transparent;
    border: 1px solid var(--color-border-2);
    border-radius: 4px;
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    margin-left: auto;
    padding: 3px 10px;
  }

  .warn-banner {
    background: color-mix(in srgb, var(--color-warning), transparent 88%);
    border: 1px solid color-mix(in srgb, var(--color-warning), transparent 55%);
    border-radius: 6px;
    color: var(--color-text);
    font-size: 12px;
    padding: 8px 12px;
  }

  /* ─── Tunnel section ─── */

  .tunnel-row {
    align-items: center;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: 10px;
    display: flex;
    gap: 12px;
    padding: 12px 16px;
  }
  .tunnel-url {
    background: var(--color-surface-3);
    border-radius: 6px;
    color: var(--color-text);
    flex: 1;
    font-family: var(--font-family-monospace);
    font-size: 13px;
    overflow: hidden;
    padding: 8px 12px;
    text-overflow: ellipsis;
    user-select: all;
    white-space: nowrap;
  }

  /* ─── Env vars section ─── */

  .env-details {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: 10px;
    overflow: hidden;
  }
  .env-summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    gap: 12px;
    list-style: none;
    padding: 16px 20px;
    user-select: none;
  }
  .env-summary::-webkit-details-marker {
    display: none;
  }
  .env-summary::before {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    content: "▸";
    font-size: 14px;
    transition: transform 150ms ease;
  }
  .env-details[open] .env-summary::before {
    transform: rotate(90deg);
  }
  .section-h {
    font-size: 17px;
    font-weight: 600;
  }
  .env-count {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-family: var(--font-family-monospace);
    font-size: 12px;
    margin-left: auto;
  }

  .env-body {
    padding: 0 20px 20px;
  }

  .env-table {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
  }

  .env-table-header {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    display: grid;
    font-family: var(--font-family-monospace);
    font-size: 12px;
    gap: 8px;
    grid-template-columns: 1fr 1fr 32px;
    padding: 4px 8px;
    text-transform: uppercase;
  }

  .env-row {
    display: grid;
    gap: 8px;
    grid-template-columns: 1fr 1fr 32px;
  }

  .env-row input {
    background: var(--color-surface-3);
    border: 1px solid var(--color-border-1);
    border-radius: 6px;
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: 13px;
    outline: none;
    padding: 6px 10px;
  }
  .env-row input:focus {
    border-color: var(--color-accent);
  }

  .col-action.remove {
    background: transparent;
    border: none;
    border-radius: 4px;
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    padding: 4px 6px;
  }
  .col-action.remove:hover {
    background: color-mix(in srgb, var(--color-text), transparent 92%);
    color: var(--color-error);
  }

  .backup-grid {
    display: grid;
    gap: 16px;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  }
  .backup-card {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
  }
  .backup-h {
    font-size: 15px;
    font-weight: 600;
    margin: 0;
  }
  .backup-sub {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: 12px;
    line-height: 1.45;
    margin: 0;
  }
  .backup-check {
    align-items: center;
    cursor: pointer;
    display: flex;
    font-size: 13px;
    gap: 8px;
  }
  .backup-check em {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-style: normal;
    font-size: 11px;
  }
  .backup-file {
    background: var(--color-surface-3);
    border: 1px dashed var(--color-border-1);
    border-radius: 6px;
    color: var(--color-text);
    font-size: 12px;
    padding: 8px;
  }
  .backup-actions {
    display: flex;
    justify-content: flex-start;
  }
  .backup-result {
    background: var(--color-surface-3);
    border-left: 3px solid var(--color-accent);
    border-radius: 4px;
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: 12px;
    margin: 0;
    padding: 10px 12px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .backup-result.err {
    border-left-color: var(--color-error);
  }
  .backup-list {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
  }
  .backup-list li {
    font-size: 12px;
    padding: 3px 0;
  }
  .backup-errors {
    color: var(--color-error);
    margin-top: 8px;
  }
  .muted {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
  }
</style>
