<!--
  Skill upload drop zone — accepts SKILL.md files or skill directories.

  Single SKILL.md: publishes instructions via JSON endpoint (no archive).
  Directory with references: packs a tar.gz in the browser and uploads
  via the multipart endpoint so reference files are included.

  @component
-->
<script lang="ts">
  import { useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { skillQueries } from "$lib/queries";
  import { parse as parseYaml } from "yaml";

  interface Props {
    inline?: boolean;
    onclose?: () => void;
    /** When set, uploads publish as a new version of this skill (skips namespace/name extraction). */
    forceNamespace?: string;
    /** When set, uploads publish as a new version of this skill (skips namespace/name extraction). */
    forceName?: string;
  }

  let { inline = false, onclose, forceNamespace, forceName }: Props = $props();

  const queryClient = useQueryClient();

  interface PendingSkill {
    name: string;
    description: string;
    skillMdContent: string;
    files: File[] | null; // null = single SKILL.md (JSON publish), File[] = directory (multipart upload)
  }

  let dragOver = $state(false);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let needsNamespace = $state(false);
  let namespaceInput = $state("tempest");
  let pendingSkill = $state<PendingSkill | null>(null);
  /** Tarball waiting on a namespace prompt. Separate from `pendingSkill`
   *  because the server (not the client) is parsing SKILL.md, so we don't
   *  have parsed fields yet — only the raw archive and the suggested name. */
  let pendingTarball = $state<{ file: File; defaultName: string } | null>(null);

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    error = null;

    // Check for directory drop via DataTransferItemList
    const items = e.dataTransfer?.items;
    if (items && items.length > 0) {
      const firstItem = items[0];
      // webkitGetAsEntry is the standard way to detect directories
      const entry = firstItem.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        await loadDirectory(entry as FileSystemDirectoryEntry);
        return;
      }
    }

    // Single file drop
    const file = e.dataTransfer?.files[0];
    if (!file) return;

    if (file.name.endsWith(".tar.gz") || file.name.endsWith(".tgz")) {
      await loadTarball(file);
    } else if (file.name === "SKILL.md" || file.name.endsWith(".md")) {
      await loadSkillMd(file);
    } else {
      error = "Drop a SKILL.md file, a folder containing one, or a .tar.gz archive";
    }
  }

  /** Send an exported tar.gz to the import-archive endpoint. Server parses
   *  SKILL.md inside and publishes. Falls back to the namespace prompt when
   *  the tarball's frontmatter has no `@<ns>/<name>` prefix. */
  async function loadTarball(file: File, namespaceOverride?: string) {
    loading = true;
    error = null;
    try {
      const formData = new FormData();
      formData.append("archive", file);
      const url = namespaceOverride
        ? `/api/daemon/api/skills/import-archive?namespace=${encodeURIComponent(namespaceOverride)}`
        : `/api/daemon/api/skills/import-archive`;
      const res = await fetch(url, { method: "POST", body: formData });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        needsNamespace?: boolean;
        defaultName?: string;
        published?: { namespace: string; name: string };
      };

      if (res.status === 400 && body.needsNamespace && body.defaultName) {
        pendingTarball = { file, defaultName: body.defaultName };
        needsNamespace = true;
        return;
      }
      if (!res.ok) {
        throw new Error(body.error ?? `Import failed: ${res.status}`);
      }
      if (!body.published) {
        throw new Error("Import succeeded but response was malformed");
      }
      await onPublishSuccess(body.published.namespace, body.published.name);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to import archive";
    } finally {
      loading = false;
    }
  }

  async function handleFolderInput(e: Event) {
    const input = e.target as HTMLInputElement;
    const fileList = input.files;
    if (!fileList || fileList.length === 0) return;
    error = null;
    loading = true;

    try {
      // webkitdirectory gives us a flat FileList with webkitRelativePath set
      const files: File[] = [];
      let skillMdFile: File | undefined;

      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        // webkitRelativePath is "dirname/path/to/file" — strip the root dir prefix
        const relPath = f.webkitRelativePath;
        const slashIdx = relPath.indexOf("/");
        const innerPath = slashIdx >= 0 ? relPath.slice(slashIdx + 1) : f.name;

        if (innerPath === "SKILL.md") {
          skillMdFile = f;
        }

        files.push(new File([f], innerPath, { type: f.type }));
      }

      if (!skillMdFile) {
        error = "Folder must contain a SKILL.md file";
        return;
      }

      const skillMdText = await skillMdFile.text();
      const parsed = parseFrontmatter(skillMdText);

      // When forced namespace/name are set, skip frontmatter name validation
      if (forceNamespace && forceName) {
        await publishWithArchive(forceNamespace, forceName, skillMdText, files);
        return;
      }

      if (!parsed.name) {
        error = "SKILL.md frontmatter must include a 'name' field";
        return;
      }

      const { namespace, skillName } = splitRef(parsed.name);

      if (!namespace) {
        pendingSkill = {
          name: skillName,
          description: parsed.description ?? "",
          skillMdContent: skillMdText,
          files,
        };
        needsNamespace = true;
        return;
      }

      await publishWithArchive(namespace, skillName, skillMdText, files);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to read folder";
    } finally {
      loading = false;
      input.value = "";
    }
  }

  /** Parse a single SKILL.md file and publish via JSON endpoint. */
  async function loadSkillMd(file: File) {
    loading = true;
    try {
      const text = await file.text();
      const parsed = parseFrontmatter(text);

      // When forced namespace/name are set, skip frontmatter name validation
      if (forceNamespace && forceName) {
        await publishJsonSkill(forceNamespace, forceName, parsed.description ?? "", text);
        return;
      }

      if (!parsed.name) {
        error = "SKILL.md frontmatter must include a 'name' field";
        return;
      }

      const { namespace, skillName } = splitRef(parsed.name);

      if (!namespace) {
        pendingSkill = {
          name: skillName,
          description: parsed.description ?? "",
          skillMdContent: text,
          files: null,
        };
        needsNamespace = true;
        return;
      }

      await publishJsonSkill(namespace, skillName, parsed.description ?? "", text);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to parse SKILL.md";
    } finally {
      loading = false;
    }
  }

  /** Load a dropped directory — find SKILL.md and upload with all files as archive. */
  async function loadDirectory(dirEntry: FileSystemDirectoryEntry) {
    loading = true;
    try {
      const files = await readDirectoryEntries(dirEntry);
      const skillMdFile = files.find((f) => f.name === "SKILL.md");

      if (!skillMdFile) {
        error = "Directory must contain a SKILL.md file";
        return;
      }

      const skillMdText = await skillMdFile.text();
      const parsed = parseFrontmatter(skillMdText);

      // When forced namespace/name are set, skip frontmatter name validation
      if (forceNamespace && forceName) {
        await publishWithArchive(forceNamespace, forceName, skillMdText, files);
        return;
      }

      if (!parsed.name) {
        error = "SKILL.md frontmatter must include a 'name' field";
        return;
      }

      const { namespace, skillName } = splitRef(parsed.name);

      if (!namespace) {
        pendingSkill = {
          name: skillName,
          description: parsed.description ?? "",
          skillMdContent: skillMdText,
          files,
        };
        needsNamespace = true;
        return;
      }

      await publishWithArchive(namespace, skillName, skillMdText, files);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to read directory";
    } finally {
      loading = false;
    }
  }

  /** Submit the namespace form and publish. */
  async function submitNamespace() {
    if (!namespaceInput.trim()) return;
    const ns = namespaceInput.trim();

    if (pendingTarball) {
      const tarball = pendingTarball;
      pendingTarball = null;
      needsNamespace = false;
      await loadTarball(tarball.file, ns);
      return;
    }

    if (!pendingSkill) return;
    loading = true;
    error = null;
    needsNamespace = false;

    try {
      if (pendingSkill.files) {
        await publishWithArchive(
          ns,
          pendingSkill.name,
          pendingSkill.skillMdContent,
          pendingSkill.files,
        );
      } else {
        await publishJsonSkill(
          ns,
          pendingSkill.name,
          pendingSkill.description,
          pendingSkill.skillMdContent,
        );
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to publish skill";
    } finally {
      loading = false;
      pendingSkill = null;
    }
  }

  // ── Publish methods ─────────────────────────────────────────────────────

  /** Publish a single SKILL.md (no archive) via JSON endpoint. The server
   *  splits embedded frontmatter into the `frontmatter` column, so we send
   *  the full SKILL.md text rather than stripping it client-side. */
  async function publishJsonSkill(
    namespace: string,
    name: string,
    description: string,
    skillMdContent: string,
  ) {
    // If description contains < or >, the server rejects it (XML injection guard).
    // Omit it so the server auto-generates one from instructions via LLM.
    const safeDescription =
      description.includes("<") || description.includes(">") ? undefined : description || undefined;

    const res = await fetch(
      `/api/daemon/api/skills/@${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: safeDescription, instructions: skillMdContent }),
      },
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `Publish failed: ${res.status}` }));
      throw new Error(
        typeof body.error === "string" ? body.error : `Publish failed: ${res.status}`,
      );
    }

    await onPublishSuccess(namespace, name);
  }

  /** Publish a skill directory with all reference files as a tar.gz archive. */
  async function publishWithArchive(
    namespace: string,
    name: string,
    skillMdContent: string,
    files: File[],
  ) {
    // Exclude SKILL.md from the archive — its content is sent separately as skillMd
    const archiveFiles = files.filter((f) => f.name !== "SKILL.md");
    const archive = await createTarGz(archiveFiles);

    const formData = new FormData();
    formData.append("archive", new File([archive], "skill.tar.gz", { type: "application/gzip" }));
    formData.append("skillMd", skillMdContent);

    // Extract description from frontmatter and send separately if safe
    const parsed = parseFrontmatter(skillMdContent);
    const desc = parsed.description ?? "";
    if (desc && !desc.includes("<") && !desc.includes(">")) {
      formData.append("description", desc);
    }

    const res = await fetch(
      `/api/daemon/api/skills/@${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/upload`,
      { method: "POST", body: formData },
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `Upload failed: ${res.status}` }));
      throw new Error(typeof body.error === "string" ? body.error : `Upload failed: ${res.status}`);
    }

    await onPublishSuccess(namespace, name);
  }

  async function onPublishSuccess(namespace: string, name: string) {
    await queryClient.invalidateQueries({ queryKey: skillQueries.all() });
    onclose?.();

    // When uploading a new version of an existing skill, stay on the same page
    if (forceNamespace && forceName) return;

    goto(`/skills/${namespace}/${name}`);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function splitRef(ref: string): { namespace: string | null; skillName: string } {
    const match = ref.match(/^@([a-z0-9-]+)\/([a-z0-9-]+)$/);
    return match
      ? { namespace: match[1], skillName: match[2] }
      : { namespace: null, skillName: ref };
  }

  function parseFrontmatter(content: string): {
    name: string | null;
    description: string | null;
    instructions: string;
  } {
    if (!content.startsWith("---")) {
      return { name: null, description: null, instructions: content.trim() };
    }

    const closingIndex = content.indexOf("\n---", 3);
    if (closingIndex === -1) {
      return { name: null, description: null, instructions: content.trim() };
    }

    const yamlBlock = content.slice(4, closingIndex);
    const body = content.slice(closingIndex + 4).trim();

    const parsed = parseYaml(yamlBlock);
    const fields = typeof parsed === "object" && parsed !== null ? parsed : {};

    return {
      name: typeof fields.name === "string" ? fields.name : null,
      description: typeof fields.description === "string" ? fields.description : null,
      instructions: body,
    };
  }

  /**
   * Creates a gzipped tarball from a list of files in the browser.
   * Uses a minimal POSIX tar implementation + CompressionStream for gzip.
   */
  async function createTarGz(files: File[]): Promise<Blob> {
    const BLOCK = 512;
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];

    for (const file of files) {
      const data = new Uint8Array(await file.arrayBuffer());
      const name = file.name;

      // Build 512-byte POSIX tar header
      const header = new Uint8Array(BLOCK);

      // name (0, 100)
      writeString(header, 0, name, 100);
      // mode (100, 8)
      writeOctal(header, 100, 0o644, 8);
      // uid (108, 8)
      writeOctal(header, 108, 0, 8);
      // gid (116, 8)
      writeOctal(header, 116, 0, 8);
      // size (124, 12)
      writeOctal(header, 124, data.byteLength, 12);
      // mtime (136, 12)
      writeOctal(header, 136, Math.floor(Date.now() / 1000), 12);
      // typeflag (156, 1) — '0' = regular file
      header[156] = 0x30;
      // magic (257, 6) — 'ustar\0'
      writeString(header, 257, "ustar\0", 6);
      // version (263, 2) — '00'
      writeString(header, 263, "00", 2);

      // checksum (148, 8) — compute after filling all other fields
      // Temporarily fill checksum field with spaces for computation
      for (let i = 148; i < 156; i++) header[i] = 0x20;
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += header[i];
      const checksumStr = sum.toString(8).padStart(6, "0");
      writeString(header, 148, checksumStr, 7);
      header[155] = 0x20;

      chunks.push(header);
      chunks.push(data);

      // Pad to 512-byte boundary
      const remainder = data.byteLength % BLOCK;
      if (remainder > 0) {
        chunks.push(new Uint8Array(BLOCK - remainder));
      }
    }

    // Two zero blocks to end the archive
    chunks.push(new Uint8Array(BLOCK * 2));

    // Concatenate into a single tar buffer
    const totalSize = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const tarBuffer = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      tarBuffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Gzip via CompressionStream
    const stream = new Blob([tarBuffer]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Response(stream).blob();

    function writeString(buf: Uint8Array, pos: number, str: string, len: number) {
      const bytes = encoder.encode(str);
      buf.set(bytes.subarray(0, len), pos);
    }

    function writeOctal(buf: Uint8Array, pos: number, value: number, len: number) {
      const str = value.toString(8).padStart(len - 1, "0");
      writeString(buf, pos, str, len - 1);
      buf[pos + len - 1] = 0;
    }
  }

  async function readDirectoryEntries(dirEntry: FileSystemDirectoryEntry): Promise<File[]> {
    const files: File[] = [];

    async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
      const all: FileSystemEntry[] = [];
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
          reader.readEntries(resolve, reject);
        });
        all.push(...batch);
      } while (batch.length > 0);
      return all;
    }

    async function readDir(entry: FileSystemDirectoryEntry, prefix: string) {
      const reader = entry.createReader();
      const entries = await readAllEntries(reader);

      for (const child of entries) {
        if (child.isFile) {
          const file = await new Promise<File>((resolve, reject) => {
            (child as FileSystemFileEntry).file(resolve, reject);
          });
          // Preserve relative path
          const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
          files.push(new File([file], relativePath, { type: file.type }));
        } else if (child.isDirectory) {
          const subPrefix = prefix ? `${prefix}/${child.name}` : child.name;
          await readDir(child as FileSystemDirectoryEntry, subPrefix);
        }
      }
    }

    await readDir(dirEntry, "");
    return files;
  }
</script>

{#if needsNamespace}
  {@const promptName = pendingTarball?.defaultName ?? pendingSkill?.name ?? ""}
  <div class="drop-zone" class:inline>
    <div class="drop-content">
      <p class="drop-label">Skill namespace</p>
      <p class="drop-hint">
        Enter the namespace for <strong>{promptName}</strong>
      </p>
      <div class="namespace-form">
        <span class="namespace-prefix">@</span>
        <input
          class="namespace-input"
          type="text"
          bind:value={namespaceInput}
          placeholder="tempest"
          onkeydown={(e) => {
            if (e.key === "Enter") submitNamespace();
          }}
        />
        <span class="namespace-sep">/</span>
        <span class="namespace-name">{promptName}</span>
      </div>
      <button class="browse-btn" onclick={submitNamespace} disabled={!namespaceInput.trim()}>
        Publish
      </button>
      {#if error}
        <p class="drop-error">{error}</p>
      {/if}
    </div>
    {#if onclose}
      <button
        type="button"
        class="close-btn"
        onclick={() => {
          needsNamespace = false;
          pendingSkill = null;
          pendingTarball = null;
          onclose?.();
        }}
      >
        Cancel
      </button>
    {/if}
  </div>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <label
    class="drop-zone"
    class:drag-over={dragOver}
    class:inline
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
  >
    <div class="drop-content">
      {#if loading}
        <p class="drop-label">Publishing skill...</p>
      {:else}
        <p class="drop-label">Drop a skill folder or .tar.gz here, or click to browse</p>
      {/if}

      {#if error}
        <p class="drop-error">{error}</p>
      {/if}
    </div>

    <input type="file" webkitdirectory hidden onchange={handleFolderInput} />

    {#if !inline && onclose}
      <button type="button" class="close-btn" onclick={(e) => { e.preventDefault(); onclose?.(); }}>Close</button>
    {/if}
  </label>
{/if}

<style>
  .drop-zone {
    align-items: center;
    border: 1px dashed var(--color-border-2);
    border-radius: var(--radius-3);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    justify-content: center;
    min-block-size: 200px;
    padding: var(--size-10);
    transition:
      border-color 200ms ease,
      background-color 200ms ease;

    &:hover {
      border-color: color-mix(in srgb, var(--color-text), transparent 25%);
    }

    &.drag-over {
      background-color: color-mix(in srgb, var(--color-highlight-1), transparent 50%);
      border-color: var(--color-text);
    }

    &.inline {
      border-style: dashed;
      min-block-size: 0;
      padding: var(--size-8) var(--size-10);
    }
  }

  .drop-content {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .drop-label {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
  }

  .browse-btn {
    background-color: var(--color-surface-2);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-5);
    transition: background-color 100ms ease;

    &:hover {
      background-color: var(--color-highlight-1);
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
  }

  .drop-error {
    background-color: color-mix(in srgb, var(--color-error), transparent 90%);
    border-radius: var(--radius-2);
    color: var(--color-error);
    font-size: var(--font-size-2);
    max-inline-size: 400px;
    padding: var(--size-2) var(--size-4);
    text-align: center;
  }

  .close-btn {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    cursor: pointer;
    font-size: var(--font-size-2);

    &:hover {
      color: var(--color-text);
    }
  }

  .namespace-form {
    align-items: center;
    display: flex;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-3);
    gap: 0;
  }

  .namespace-prefix {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
  }

  .namespace-input {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-3);
    inline-size: 12ch;
    padding: var(--size-1) var(--size-2);
  }

  .namespace-sep {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    padding-inline: var(--size-0-5);
  }

  .namespace-name {
    color: var(--color-text);
    font-weight: var(--font-weight-6);
  }
</style>
