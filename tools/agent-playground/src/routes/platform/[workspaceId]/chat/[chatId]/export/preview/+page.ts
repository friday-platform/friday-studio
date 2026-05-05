/**
 * Preview-page render flags.
 *
 * `csr = false` strips hydration scripts and `modulepreload` tags so the
 * rendered HTML is openable as a static file with no JS dependency.
 *
 * `ssr = true` is non-negotiable: the playground's root `+layout.ts`
 * exports `ssr = false`, which makes every other route render as the SPA
 * fallback. The export pipeline only works when this leaf opts back into
 * SSR — without it `inlineStyleThreshold: Infinity` has nothing to inline
 * and the response is the 980-byte SPA shell.
 *
 * `prerender = false` because chat data is dynamic per workspace + chatId.
 */
export const csr = false;
export const ssr = true;
export const prerender = false;
