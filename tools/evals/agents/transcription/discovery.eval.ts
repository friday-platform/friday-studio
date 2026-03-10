/**
 * Transcription discovery evals — tests UUID regex extraction and artifact
 * validation against different prompt formats.
 *
 * Uploads real audio + non-audio fixtures to the daemon, then runs
 * discoverAudioFiles against the real artifact storage.
 *
 * Prereqs: daemon running on localhost:8080.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { type DiscoveredAudio, discoverAudioFiles } from "@atlas/bundled-agents";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

await loadCredentials();

const DAEMON_URL = process.env.ATLAS_DAEMON_URL || "http://localhost:8080";
const FIXTURES_DIR = join(import.meta.dirname!, "fixtures");

const adapter = new AgentContextAdapter();

// ---------------------------------------------------------------------------
// Fixture upload
// ---------------------------------------------------------------------------

interface UploadedFixture {
  artifactId: string;
  fileName: string;
}

async function uploadFixture(fileName: string): Promise<UploadedFixture> {
  const filePath = join(FIXTURES_DIR, fileName);
  const bytes = await readFile(filePath);

  const formData = new FormData();
  formData.append("file", new File([bytes], fileName));
  formData.append("workspaceId", "eval-workspace");

  const resp = await fetch(`${DAEMON_URL}/api/artifacts/upload`, {
    method: "POST",
    body: formData,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Fixture upload failed for ${fileName}: ${resp.status} ${text}`);
  }

  const { artifact } = (await resp.json()) as { artifact: { id: string } };
  return { artifactId: artifact.id, fileName };
}

async function uploadTextFixture(fileName: string, content: string): Promise<UploadedFixture> {
  const formData = new FormData();
  formData.append("file", new File([content], fileName, { type: "text/plain" }));
  formData.append("workspaceId", "eval-workspace");

  const resp = await fetch(`${DAEMON_URL}/api/artifacts/upload`, {
    method: "POST",
    body: formData,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Fixture upload failed for ${fileName}: ${resp.status} ${text}`);
  }

  const { artifact } = (await resp.json()) as { artifact: { id: string } };
  return { artifactId: artifact.id, fileName };
}

// Upload fixtures once at module load
const [audioFixture, audio2Fixture, textFixture] = await Promise.all([
  uploadFixture("speech.mp3"),
  uploadFixture("speech2.mp3"),
  uploadTextFixture("notes.txt", "These are some meeting notes."),
]);

// ---------------------------------------------------------------------------
// Prompt formatters
// ---------------------------------------------------------------------------

function attachedFile(fixture: UploadedFixture): string {
  return `[Attached files: ${fixture.fileName} (artifact:${fixture.artifactId})]`;
}

function signalData(entries: Record<string, string>): string {
  return `## Signal Data\n${JSON.stringify(entries, null, 2)}`;
}

function workspaceResources(files: UploadedFixture[]): string {
  const lines = files.map((f) => `- ${f.fileName} (artifact:${f.artifactId}): Uploaded file`);
  return `## Workspace Resources\n\n### Files\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Serializable result wrapper (Map doesn't survive JSON.stringify)
// ---------------------------------------------------------------------------

interface DiscoveryResult {
  artifactIds: string[];
  artifactCount: number;
}

function toResult(discovered: DiscoveredAudio): DiscoveryResult {
  return { artifactIds: discovered.artifactIds, artifactCount: discovered.artifacts.size };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface DiscoveryCase extends BaseEvalCase {
  expectedIds: string[];
}

const cases: DiscoveryCase[] = [
  {
    id: "single-attached",
    name: "single attached audio file",
    input: `${attachedFile(audioFixture)}\n\nTranscribe this recording`,
    expectedIds: [audioFixture.artifactId],
  },
  {
    id: "multiple-attached",
    name: "two attached audio files",
    input: `${attachedFile(audioFixture)}\n${attachedFile(audio2Fixture)}\n\nTranscribe both files`,
    expectedIds: [audioFixture.artifactId, audio2Fixture.artifactId],
  },
  {
    id: "signal-data",
    name: "audio artifact ID in signal data payload",
    input: `${signalData({ audio_file: audioFixture.artifactId })}\n\nTranscribe the attached audio`,
    expectedIds: [audioFixture.artifactId],
  },
  {
    id: "workspace-resources",
    name: "audio file in workspace resources section",
    input: `${workspaceResources([audioFixture])}\n\nTranscribe the audio file from my workspace`,
    expectedIds: [audioFixture.artifactId],
  },
  {
    id: "mixed-types",
    name: "audio + non-audio artifacts — only audio returned",
    input: `${attachedFile(audioFixture)}\n${attachedFile(textFixture)}\n\nTranscribe the audio`,
    expectedIds: [audioFixture.artifactId],
  },
  {
    id: "no-artifacts",
    name: "prompt with no artifact references",
    input: "Can you transcribe some audio for me?",
    expectedIds: [],
  },
  {
    id: "fabricated-id",
    name: "prompt with non-existent UUID — validation rejects it",
    input: `[Attached files: fake.mp3 (artifact:00000000-0000-0000-0000-000000000000)]\n\nTranscribe this`,
    expectedIds: [],
  },
];

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

export const evals: EvalRegistration[] = cases.map((testCase) =>
  defineEval({
    name: `transcription/discovery/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: async (input) => toResult(await discoverAudioFiles(input)),
      score: (result) => {
        const scores = [];
        const foundIds = new Set(result.artifactIds);
        const expectedIds = new Set(testCase.expectedIds);

        // Did we find all expected IDs?
        const recall =
          expectedIds.size === 0
            ? foundIds.size === 0
              ? 1
              : 0
            : [...expectedIds].filter((id) => foundIds.has(id)).length / expectedIds.size;
        scores.push(
          createScore(
            "recall",
            recall,
            `found ${[...expectedIds].filter((id) => foundIds.has(id)).length}/${expectedIds.size} expected IDs`,
          ),
        );

        // Did we avoid returning unexpected IDs?
        const spurious = [...foundIds].filter((id) => !expectedIds.has(id));
        const precision =
          foundIds.size === 0 ? 1 : (foundIds.size - spurious.length) / foundIds.size;
        scores.push(
          createScore(
            "precision",
            precision,
            spurious.length > 0
              ? `${spurious.length} unexpected ID(s): ${spurious.join(", ")}`
              : "no spurious IDs",
          ),
        );

        // Exact match — both recall and precision are 1
        const exact = recall === 1 && precision === 1 ? 1 : 0;
        scores.push(
          createScore(
            "exact-match",
            exact,
            exact ? "perfect match" : `expected [${[...expectedIds]}], got [${[...foundIds]}]`,
          ),
        );

        return scores;
      },
    },
  }),
);
