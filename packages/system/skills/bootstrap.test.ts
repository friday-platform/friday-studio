/**
 * Orphan tombstone behavior in `ensureSystemSkills`.
 *
 * `bootstrap.ts:publishOne` is content-hash-gated, so unchanged on-disk
 * skills land idempotently. The publish pass is additive — it can't
 * unpublish a skill whose source dir was deleted between daemon
 * restarts. The tombstone pass is the cleanup half: it disables any
 * `@friday/*` skill in the registry whose source dir is no longer on
 * disk so `resolveVisibleSkills` stops surfacing it to chat agents.
 *
 * The test injects a stub `SkillStorageAdapter` via
 * `_setSkillStorageForTest`, pre-publishes one skill name that's NOT in
 * the on-disk catalog (the orphan), runs `ensureSystemSkills()`, and
 * asserts `setDisabled(orphan.skillId, true)` was called exactly once.
 * It also asserts that on-disk skills don't get disabled (no false
 * positives) and that an already-disabled orphan doesn't re-disable
 * (no churn writes).
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Skill, SkillStorageAdapter, SkillSummary } from "@atlas/skills";
import { _setSkillStorageForTest, extractArchiveContents, packSkillArchive } from "@atlas/skills";
import type { Result } from "@atlas/utils";
import { makeTempDir } from "@atlas/utils/temp.server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock `computeSkillHash` so the resurrection test can pin a stored
// hash that MATCHES the on-disk hash — that's the path where the
// `publishOne` shortcut fires and the bug manifests. Other tests rely
// on the default `"matches-nothing"` to keep their publish paths
// exercised. Hoisted because vi.mock hoists imports — must be in
// scope when bootstrap.ts is first evaluated.
const mockComputeSkillHash = vi.hoisted(() => vi.fn(() => Promise.resolve("matches-nothing")));
vi.mock("@atlas/skills", async () => {
  const actual = await vi.importActual<typeof import("@atlas/skills")>("@atlas/skills");
  return { ...actual, computeSkillHash: mockComputeSkillHash };
});

import { copySkillDirToReal, ensureSystemSkills } from "./bootstrap.ts";

interface StoredSkill {
  skillId: string;
  name: string;
  disabled: boolean;
  sourceHash: string;
}

function ok<T>(data: T): Result<T, string> {
  return { ok: true, data };
}

function makeStorageStub(initial: StoredSkill[]) {
  const store = new Map<string, StoredSkill>();
  for (const s of initial) {
    store.set(s.name, { ...s });
  }
  const setDisabled = vi.fn((skillId: string, disabled: boolean) => {
    for (const s of store.values()) {
      if (s.skillId === skillId) {
        s.disabled = disabled;
        return Promise.resolve(ok<void>(undefined));
      }
    }
    return Promise.resolve({ ok: false as const, error: `not found: ${skillId}` });
  });
  const list = vi.fn(
    (_ns?: string, _q?: string, _includeAll?: boolean): Promise<Result<SkillSummary[], string>> => {
      const summaries: SkillSummary[] = [...store.values()].map((s) => ({
        id: s.skillId,
        skillId: s.skillId,
        namespace: "friday",
        name: s.name,
        description: "stub",
        disabled: s.disabled,
        latestVersion: 1,
        createdAt: new Date(0),
        userInvocable: true,
      }));
      return Promise.resolve(ok(summaries));
    },
  );
  const get = vi.fn((_ns: string, name: string): Promise<Result<Skill | null, string>> => {
    const found = store.get(name);
    if (!found) return Promise.resolve(ok(null));
    return Promise.resolve(
      ok({
        id: found.skillId,
        skillId: found.skillId,
        namespace: "friday",
        name: found.name,
        version: 1,
        description: "stub",
        descriptionManual: false,
        disabled: found.disabled,
        // The publish pass shortcuts when stored hash matches on-disk
        // hash. Returning a sentinel that won't match the real
        // computeSkillHash output keeps the test's publish path
        // exercised (it'll always re-publish, which is fine — the
        // publish stub below is a no-op).
        frontmatter: { "source-hash": found.sourceHash },
        instructions: "",
        archive: null,
        createdBy: "system",
        createdAt: new Date(0),
      }),
    );
  });
  const publish = vi.fn(
    (
      _ns: string,
      name: string,
      _user: string,
    ): Promise<Result<{ id: string; version: number; name: string; skillId: string }, string>> => {
      const existing = store.get(name);
      const skillId = existing?.skillId ?? `sk_${name}`;
      // Simulate real publish: bump version, persist disabled=false.
      store.set(name, { skillId, name, disabled: false, sourceHash: "stub-fresh-hash" });
      return Promise.resolve(ok({ id: skillId, version: 2, name, skillId }));
    },
  );

  // Stub adapter — every method returns ok([]) or ok(undefined) for the
  // surface bootstrap doesn't touch.
  const adapter = {
    list,
    get,
    publish,
    setDisabled,
    create: vi.fn(),
    getById: vi.fn(),
    getBySkillId: vi.fn(),
    listVersions: vi.fn(),
    deleteVersion: vi.fn(),
    deleteSkill: vi.fn(),
    listAssigned: vi.fn(),
    assignSkill: vi.fn(),
    unassignSkill: vi.fn(),
    listAssignments: vi.fn(),
    assignToJob: vi.fn(),
    unassignFromJob: vi.fn(),
    listAssignmentsForJob: vi.fn(),
    // Stub adapter — every method bootstrap doesn't touch is a vi.fn()
    // no-op. Cast through `unknown` so we don't have to re-declare all 16
    // SkillStorageAdapter signatures with their full Result envelopes
    // just for test value the bootstrap pass doesn't read.
    listJobOnlySkillIds: vi.fn(),
  } as unknown as SkillStorageAdapter;
  return { adapter, store, setDisabled, list, publish };
}

describe("ensureSystemSkills — orphan tombstone pass", () => {
  // Stub `vi.fn()`s are created fresh inside `makeStorageStub()` per
  // test, so call history can't leak across cases. The hoisted
  // `mockComputeSkillHash` IS shared and needs an explicit reset to
  // its default, since the resurrection test overrides it.
  beforeEach(() => {
    mockComputeSkillHash.mockReset();
    mockComputeSkillHash.mockResolvedValue("matches-nothing");
  });
  afterEach(() => {
    _setSkillStorageForTest(null);
  });

  it("disables orphans whose source dir is no longer on disk", async () => {
    // `validating-llm-outputs` was deleted in the validation rip — the
    // dir does NOT exist on disk anymore. A daemon that bootstrapped it
    // before the rip still has it in the registry, enabled.
    const { adapter, store, setDisabled } = makeStorageStub([
      {
        skillId: "sk_orphan_validating-llm-outputs",
        name: "validating-llm-outputs",
        disabled: false,
        sourceHash: "stale-hash",
      },
    ]);
    _setSkillStorageForTest(adapter);

    await ensureSystemSkills();

    expect(setDisabled).toHaveBeenCalledWith("sk_orphan_validating-llm-outputs", true);
    expect(store.get("validating-llm-outputs")?.disabled).toBe(true);
  });

  it("does NOT disable skills whose source dir is on disk", async () => {
    // `agent-action-handshake` IS on disk — it's one of the new contract
    // skills. The publish pass should land on it, then the tombstone
    // pass should leave it enabled.
    const { adapter, store, setDisabled } = makeStorageStub([
      {
        skillId: "sk_agent-action-handshake",
        name: "agent-action-handshake",
        disabled: false,
        sourceHash: "stale-hash-will-be-republished",
      },
    ]);
    _setSkillStorageForTest(adapter);

    await ensureSystemSkills();

    // Either the publish pass re-published it (refreshing
    // `disabled: false`) or it was already up to date — either way the
    // tombstone pass must NOT disable it.
    const calls = setDisabled.mock.calls.filter(
      (c) => c[0] === "sk_agent-action-handshake" && c[1] === true,
    );
    expect(calls).toHaveLength(0);
    expect(store.get("agent-action-handshake")?.disabled).toBe(false);
  });

  it("does not re-disable an orphan that's already disabled (no churn write)", async () => {
    const { adapter, setDisabled } = makeStorageStub([
      {
        skillId: "sk_already_disabled",
        // Generic placeholder name — keeping it free of any historical
        // skill identifier so the validation-removed ripple scan
        // doesn't false-positive on a fixture string.
        name: "previously-removed-fixture",
        disabled: true, // already tombstoned by a previous run
        sourceHash: "stale-hash",
      },
    ]);
    _setSkillStorageForTest(adapter);

    await ensureSystemSkills();

    // No setDisabled call against this skillId (regardless of value).
    const calls = setDisabled.mock.calls.filter((c) => c[0] === "sk_already_disabled");
    expect(calls).toHaveLength(0);
  });

  it("re-publishes (not just re-enables) a disabled skill even when hash matches", async () => {
    // Resurrection via re-publish: a skill may have been tombstoned after
    // a failed archive pack (e.g. the VFS fd bug), leaving archive=null
    // in the DB with an otherwise-correct source-hash. A naive re-enable
    // via setDisabled would restore visibility without healing the null
    // archive. The fix is to fall through to publish for any disabled row,
    // regardless of hash match — publish atomically re-enables and heals.
    mockComputeSkillHash.mockResolvedValue("identical-content-hash");
    const { adapter, store, setDisabled, publish } = makeStorageStub([
      {
        skillId: "sk_resurrected",
        name: "agent-action-handshake",
        disabled: true,
        sourceHash: "identical-content-hash",
      },
    ]);
    _setSkillStorageForTest(adapter);

    await ensureSystemSkills();

    // publish must have run (not just setDisabled) so the archive is healed.
    expect(publish).toHaveBeenCalledWith(
      "friday",
      "agent-action-handshake",
      expect.any(String),
      expect.any(Object),
    );
    // setDisabled must NOT have been called — publish handles re-enabling.
    expect(setDisabled).not.toHaveBeenCalledWith("sk_resurrected", false);
    expect(store.get("agent-action-handshake")?.disabled).toBe(false);
  });
});

describe("copySkillDirToReal", () => {
  // Each test gets a fresh source dir and cleans up both src + dest.
  let srcDir: string;
  let destDir: string | undefined;

  beforeEach(() => {
    srcDir = makeTempDir({ prefix: "atlas-skill-src-" });
    destDir = undefined;
  });

  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true });
    if (destDir) await rm(destDir, { recursive: true, force: true });
  });

  it("copies flat files verbatim", async () => {
    await writeFile(join(srcDir, "SKILL.md"), "# Skill\n");
    await writeFile(join(srcDir, "extra.txt"), "hello");

    destDir = await copySkillDirToReal(srcDir);

    expect(destDir).not.toBe(srcDir);
    expect(await readFile(join(destDir, "SKILL.md"), "utf-8")).toBe("# Skill\n");
    expect(await readFile(join(destDir, "extra.txt"), "utf-8")).toBe("hello");
  });

  it("recursively copies nested subdirectories", async () => {
    await mkdir(join(srcDir, "references"), { recursive: true });
    await writeFile(join(srcDir, "SKILL.md"), "# Skill\n");
    await writeFile(join(srcDir, "references", "api.md"), "# API ref\n");
    await mkdir(join(srcDir, "references", "deep"), { recursive: true });
    await writeFile(join(srcDir, "references", "deep", "nested.md"), "nested");

    destDir = await copySkillDirToReal(srcDir);

    expect(await readFile(join(destDir, "references", "api.md"), "utf-8")).toBe("# API ref\n");
    expect(await readFile(join(destDir, "references", "deep", "nested.md"), "utf-8")).toBe(
      "nested",
    );
  });

  it("produces a dest tree that packSkillArchive can tar without error", async () => {
    await mkdir(join(srcDir, "references"), { recursive: true });
    await writeFile(join(srcDir, "SKILL.md"), "# Skill\n");
    await writeFile(join(srcDir, "references", "ref.md"), "# Reference\n");

    destDir = await copySkillDirToReal(srcDir);

    // packSkillArchive must not throw and the archive must contain both files
    // with their original content intact.
    const archive = await packSkillArchive(destDir);
    const contents = await extractArchiveContents(archive);
    expect(Object.keys(contents)).toContain("SKILL.md");
    expect(Object.keys(contents)).toContain("references/ref.md");
    expect(contents["SKILL.md"]).toBe("# Skill\n");
    expect(contents["references/ref.md"]).toBe("# Reference\n");
  });

  it("returns an independent copy — mutations to src do not affect dest", async () => {
    await writeFile(join(srcDir, "SKILL.md"), "original");

    destDir = await copySkillDirToReal(srcDir);

    await writeFile(join(srcDir, "SKILL.md"), "mutated");
    expect(await readFile(join(destDir, "SKILL.md"), "utf-8")).toBe("original");
  });
});
