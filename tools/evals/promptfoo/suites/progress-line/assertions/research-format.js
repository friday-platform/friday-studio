// Format gate for research progress updates. The research system prompt
// (prompts/research.txt) mandates "Maximum 4 words, start with an active verb"
// — NOT the leading -ing verb that status-line.js enforces for the progress /
// web-search cases. Kept separate so a valid bare-verb line like
// "Analyze AI safety progress" isn't false-failed by the -ing gate.
//
// Promptfoo calls this with a default export receiving `(output, context)`.
// Returns {pass, score, reason}; recorded under the `metric:` on the assert.

module.exports = (output) => {
  const trimmed = String(output ?? "").trim();

  if (/\n/.test(trimmed)) {
    return { pass: false, score: 0, reason: "Multi-line" };
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) {
    return { pass: false, score: 0, reason: `Expected ≤4 words, got ${words.length}` };
  }

  // "Start with active verb" — a leading capitalized word, no -ing requirement.
  if (!/^[A-Z][a-z]+\b/.test(trimmed)) {
    return { pass: false, score: 0.5, reason: "Should start with a capitalized verb" };
  }

  return { pass: true, score: 1, reason: "≤4 words, leading verb" };
};
