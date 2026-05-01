/**
 * Transcription agent evals — full integration tests.
 *
 * Uploads audio fixtures to the running daemon, then runs the transcription
 * agent against real artifact storage and real Groq Whisper API.
 *
 * Prereqs: daemon running on localhost:8080, GROQ_API_KEY configured.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { transcriptionAgent } from "@atlas/bundled-agents";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

await loadCredentials();

// FRIDAYD_URL is the canonical name (set by friday-launcher);
// FRIDAY_DAEMON_URL kept as legacy alias to match the resolution chain in
// packages/openapi-client/src/utils.ts:50.
const DAEMON_URL =
  process.env.FRIDAYD_URL || process.env.FRIDAY_DAEMON_URL || "http://localhost:8080";
const FIXTURES_DIR = join(import.meta.dirname ?? ".", "fixtures");

const adapter = new AgentContextAdapter();

// ---------------------------------------------------------------------------
// Fixture upload
// ---------------------------------------------------------------------------

interface UploadedFixture {
  artifactId: string;
  fileName: string;
}

/**
 * Uploads a fixture file to the daemon's artifact storage.
 * Returns the artifact ID for use in eval prompts.
 */
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

// Upload fixtures once at module load
const [speechFixture, speech2Fixture, silentFixture] = await Promise.all([
  uploadFixture("speech.mp3"),
  uploadFixture("speech2.mp3"),
  uploadFixture("silent.mp3"),
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Formats an artifact reference the way message windowing presents attachments. */
function attachedFile(fixture: UploadedFixture): string {
  return `[Attached files: ${fixture.fileName} (artifact:${fixture.artifactId})]`;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface TranscriptionCase extends BaseEvalCase {
  fixtures: UploadedFixture[];
  expectedTranscriptCount: number;
  /** Criteria for llmJudge on transcript content (only for speech cases). */
  contentCriteria?: string;
}

const cases: TranscriptionCase[] = [
  {
    id: "single-file",
    name: "single audio file transcription",
    input: `${attachedFile(speechFixture)}\n\nTranscribe this`,
    fixtures: [speechFixture],
    expectedTranscriptCount: 1,
    contentCriteria:
      "The transcript contains speech about a test recording and includes the phrase 'the quick brown fox jumps over the lazy dog' (or close paraphrase).",
  },
  {
    id: "multiple-files",
    name: "batch transcription of two audio files",
    input: `${attachedFile(speechFixture)}\n${attachedFile(speech2Fixture)}\n\nTranscribe these files`,
    fixtures: [speechFixture, speech2Fixture],
    expectedTranscriptCount: 2,
    contentCriteria:
      "Two transcripts are present. One mentions 'quick brown fox' and the other mentions 'batch transcription' or 'multiple files'. Both are non-trivial (more than a few words each).",
  },
  {
    id: "silent-audio",
    name: "silent audio — graceful handling",
    input: `${attachedFile(silentFixture)}\n\nTranscribe this`,
    fixtures: [silentFixture],
    expectedTranscriptCount: 1,
  },
];

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

export const evals: EvalRegistration[] = cases.map((testCase) =>
  defineEval({
    name: `transcription/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: (input, context) => transcriptionAgent.execute(input, context),
      score: async (result) => {
        const scores = [];

        // Did the agent succeed or handle gracefully?
        if (testCase.id === "silent-audio") {
          // Silent audio: either an error about no speech OR a short hallucinated phrase — both are acceptable
          const handledGracefully =
            result.ok ||
            result.error.reason.includes("No speech") ||
            result.error.reason.includes("transcription");
          scores.push(
            createScore(
              "graceful-handling",
              handledGracefully ? 1 : 0,
              handledGracefully
                ? "Silent audio handled gracefully"
                : `Unexpected result: ${JSON.stringify(result)}`,
            ),
          );
          return scores;
        }

        // Speech cases: agent should succeed
        if (!result.ok) {
          scores.push(createScore("agent-success", 0, `Agent failed: ${result.error.reason}`));
          return scores;
        }

        scores.push(createScore("agent-success", 1, "Agent returned ok"));

        // Transcript count matches expected
        const successfulTranscripts = result.data.transcripts.filter((t) => t.status === "ok");
        const countMatch = successfulTranscripts.length === testCase.expectedTranscriptCount;
        scores.push(
          createScore(
            "transcript-count",
            countMatch ? 1 : 0,
            `expected ${testCase.expectedTranscriptCount}, got ${successfulTranscripts.length}`,
          ),
        );

        // Artifact refs created
        const refs = result.artifactRefs ?? [];
        const refsMatch = refs.length === testCase.expectedTranscriptCount;
        scores.push(
          createScore(
            "artifacts-created",
            refsMatch ? 1 : 0,
            `expected ${testCase.expectedTranscriptCount} artifact refs, got ${refs.length}`,
          ),
        );

        // Content accuracy via LLM judge (speech cases only)
        if (testCase.contentCriteria && successfulTranscripts.length > 0) {
          const transcriptTexts = successfulTranscripts
            .map((t) => `[${t.fileName}]: ${t.status === "ok" ? t.transcript : ""}`)
            .join("\n\n");
          const judge = await llmJudge(transcriptTexts, testCase.contentCriteria);
          scores.push(judge);
        }

        return scores;
      },
    },
  }),
);
