/**
 * Thin wrapper around beautiful-mermaid's synchronous SVG renderer.
 *
 * Passes CSS variable design tokens so diagrams inherit the app's
 * color theme via the cascade -- no re-render needed on theme change.
 *
 * @module
 */

import { renderMermaidSVG } from "beautiful-mermaid";

/**
 * Render a Mermaid definition string to an SVG string, or null on error.
 *
 * Uses CSS custom properties for theming so the output responds to
 * light/dark mode without re-rendering. Safe to call inside Svelte 5
 * `$derived` computations (synchronous, no DOM needed).
 *
 * @param definition - Mermaid diagram source text
 * @returns SVG string, or null if the definition is empty or parsing fails
 */
export function renderDiagram(definition: string): string | null {
  if (!definition.trim()) return null;
  try {
    return renderMermaidSVG(definition, {
      bg: "var(--color-surface-1)",
      fg: "var(--color-text)",
      accent: "var(--color-accent)",
      transparent: true,
    });
  } catch {
    return null;
  }
}
