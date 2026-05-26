/**
 * Reusable assertion bank: "the model didn't punt the prompt back as a
 * refusal or placeholder complaint."
 *
 * Patterns mirror the original `notARefusalScore` from PR #199. Use
 * `not-icontains` (built-in case-insensitive) for simple literals and
 * `not-regex` for genuine alternations. JS RegExp has no inline `(?i)` flag,
 * so case-insensitivity rides on character classes (`[Ii]`).
 *
 * @param metric  Promptfoo metric name to attribute these assertions to.
 *                Defaults to "NotARefusal" — change it if a suite wants to
 *                bucket separately in reports.
 */
export function notARefusalAsserts(metric = "NotARefusal"): Array<Record<string, unknown>> {
  return [
    { type: "not-regex", value: "missing (required )?input", metric },
    { type: "not-regex", value: "[nN]o input (was )?(provided|given|supplied)", metric },
    { type: "not-icontains", value: "placeholder", metric },
    { type: "not-icontains", value: "template variable", metric },
    { type: "not-icontains", value: "template reference", metric },
    { type: "not-icontains", value: "unresolved variable", metric },
    { type: "not-icontains", value: "unresolved reference", metric },
    // The canonical "model punts because input looks unresolved" shape from
    // PR #199. Enumerated branches are too many (4 verbs × 2 see-words × 2
    // optional-article × 2 nouns = 32); regex with a leading `[iI]` class
    // covers both cases.
    {
      type: "not-regex",
      value: "[iI] (don't|do not|cannot|can't) (have|see) (the )?(input|value)",
      metric,
    },
  ];
}
