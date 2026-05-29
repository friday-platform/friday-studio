// Scores how well an output matches the "status line" contract.
// Mirrors statusLineScore() in tools/evals/agents/small-llm/small-llm.eval.ts.
//
// Promptfoo calls this with a default export receiving `(output, context)`.
// Return a {pass, score, reason} object; promptfoo records the score under the
// `metric:` name set on the assert.

// Only patterns that catch output which PASSES the leading -ing gate below but
// still breaks the contract. Opener blocklists (refusals, determiners, hedges)
// were dropped: the positive `^[A-Z][a-z]+ing\b` gate already fails all of them,
// and with no `threshold` on the assert the score is cosmetic — they added no
// pass/fail signal.
const FAIL_PATTERNS = [
  /\d+\.\s+\*?\*?[A-Z]/i, // numbered/bulleted list item — even on a single line
  /\n/, // multi-line
];

module.exports = (output) => {
  const trimmed = String(output ?? "").trim();

  for (const pattern of FAIL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { pass: false, score: 0, reason: `Matched fail pattern: ${pattern}` };
    }
  }

  if (trimmed.length > 50) {
    return { pass: false, score: 0.5, reason: `Too long: ${trimmed.length} chars` };
  }

  if (/^[A-Z][a-z]+ing\b/.test(trimmed)) {
    return { pass: true, score: 1, reason: "Proper -ing verb format" };
  }

  // No leading -ing verb: contract violated. Fail so the score actually gates.
  // (Without a threshold, `pass: true` would pass regardless of the score.)
  return { pass: false, score: 0.7, reason: "Missing leading -ing verb" };
};
