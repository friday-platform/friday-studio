import type { KnipConfig } from "knip";
import { sveltePreprocess } from "svelte-preprocess";
import { compile, preprocess } from "svelte/compiler";

const sveltePreprocessor = sveltePreprocess();

const config: KnipConfig = {
  ignore: [".svelte-kit", "src/i18n/**"],
  paths: {
    "$app/*": ["node_modules/@sveltejs/kit/src/runtime/app/*"],
    "$env/*": [".svelte-kit/ambient.d.ts"],
    "$lib/*": ["src/lib/*"],
  },
  compilers: {
    css: (text: string) => [...text.matchAll(/(?<=@)import[^;]+/g)].join("\n"),
    svelte: async (text: string) => {
      const processed = await preprocess(text, sveltePreprocessor, { filename: "dummy.ts" });
      const compiled = compile(processed.code, {});
      return compiled.js.code;
    },
  },
};

export default config;
