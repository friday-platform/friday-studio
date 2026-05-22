// Scores how well an output matches the "status line" contract.
// Mirrors statusLineScore() in tools/evals/agents/small-llm/small-llm.eval.ts.
//
// Promptfoo calls this with a default export receiving `(output, context)`.
// Return a {pass, score, reason} object; promptfoo records the score under the
// `metric:` name set on the assert.

const FAIL_PATTERNS = [
  /^I('m| am| cannot| can't| don't)/i,
  /^(Some|Here|The|There|This|These|Those)\s/i,
  /\d+\.\s+\*?\*?[A-Z]/i,
  /^(Unfortunately|However|Sorry)/i,
  /\n/,
];

module.exports = (output) => {
  const trimmed = String(output ?? '').trim();

  for (const pattern of FAIL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { pass: false, score: 0, reason: `Matched fail pattern: ${pattern}` };
    }
  }

  if (trimmed.length > 50) {
    return { pass: false, score: 0.5, reason: `Too long: ${trimmed.length} chars` };
  }

  if (/^[A-Z][a-z]+ing\b/.test(trimmed)) {
    return { pass: true, score: 1, reason: 'Proper -ing verb format' };
  }

  return { pass: true, score: 0.7, reason: 'Acceptable but not ideal format' };
};
