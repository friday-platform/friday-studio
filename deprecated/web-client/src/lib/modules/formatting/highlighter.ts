import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import jsonLang from "shiki/langs/json.mjs";

export const jsonHighlighter = createHighlighterCoreSync({
  themes: [
    {
      name: "atlas-json",
      type: "dark",
      settings: [
        { scope: ["support.type.property-name.json"], settings: { foreground: "var(--blue-3)" } },
        { scope: ["string.quoted.double.json"], settings: { foreground: "var(--green-3)" } },
        { scope: ["constant.numeric.json"], settings: { foreground: "var(--yellow-3)" } },
        { scope: ["constant.language.json"], settings: { foreground: "var(--purple-3)" } },
        {
          scope: [
            "punctuation.definition.dictionary",
            "punctuation.definition.array",
            "punctuation.separator",
            "punctuation.definition.string",
          ],
          settings: { foreground: "var(--color-text)" },
        },
      ],
      fg: "var(--color-text)",
      bg: "transparent",
    },
  ],
  langs: [jsonLang],
  engine: createJavaScriptRegexEngine(),
});
