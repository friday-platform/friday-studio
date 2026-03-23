# @atlas/ui

## Design Context

### Users

Technical and non-technical users managing autonomous AI agents. They're
configuring workflows, monitoring agent runs, reading conversation transcripts,
and managing workspaces. Context is frequently high-stakes (production agents)
and information-dense (logs, status, timelines). The job: understand what agents
are doing, intervene when needed, iterate on configuration fast.

### Brand Personality

**Sharp, Fast, Minimal.** Confident and opinionated — the UI takes a stance
rather than offering every option. Communicates competence through restraint.
No filler, no decoration for its own sake. Every element earns its pixels.

**Emotional goals:** Control, clarity, speed. Users should feel like they have
a firm grip on complex autonomous systems. The interface should feel like a
precision instrument, not a dashboard.

### Aesthetic Direction

**Visual tone:** High-density, low-noise. Information-forward with clear
hierarchy. Subtle depth via shadows and surface layering rather than heavy
borders or ornament.

**References:**
- **Linear** — dense information, fast interactions, polished dark mode, keyboard-first
- **Raycast** — local-first energy, command palette UX, snappy and responsive
- **Vercel Dashboard** — minimal chrome, status-focused, developer-oriented
- **Buildkite** — pipeline visualization, status-driven color coding, information density that stays readable

**Anti-references:**
- **Enterprise SaaS** — no bloated, checkbox-driven, generic dashboard energy
- **Over-designed** — no Dribbble-bait, no animations for their own sake, no form over function
- **Cutesy/Consumer** — no bubbly rounded UI, no mascots, no gratuitous illustrations

**Theme:** System-preference dark/light mode (automatic). Full color palette for
both. P3 wide-gamut color support with sRGB fallback.

### Design System

- **CSS only** — vanilla CSS with design tokens via custom properties. No Tailwind.
- **Logical properties** — `inline-size` not `width`, `padding-inline-start` not `padding-left`
- **Alphabetical CSS** — properties sorted alphabetically within rules
- **Scalable tokens** — spacing, type, and radii all multiply through `--size-scale`, `--text-scale`, `--radius-scale`
- **System fonts** — `ui-sans-serif, system-ui` stack. No custom web fonts.
- **Melt UI** — headless accessible primitives (dialogs, dropdowns, popovers). Custom styling on top.
- **Custom SVG icons** — inline, `stroke="currentColor"`, 16x16 viewBox
- **Scoped styles** — component-level `<style>` blocks, no global utility classes
- **6 accent families** — yellow, green, red, blue, brown, purple — mapped to `--accent-1/2/3` via class

### Design Principles

1. **Density over sprawl** — Pack information tight, use hierarchy to manage complexity. Scrolling is worse than scanning.
2. **Status is color, not chrome** — Communicate state through the accent color system, not badges/pills/icons stacked on top of each other.
3. **Earn every element** — If it doesn't help the user act or understand, remove it. No decorative spacers, no placeholder illustrations, no "coming soon" sections.
4. **Fast by default** — Interactions should feel instant. Prefer CSS transitions over JS animations. Never block the UI.
5. **System-native feel** — Lean into platform conventions (system fonts, native scrollbars, prefers-color-scheme). Feel like a native app that happens to run in a browser.

### Accessibility

No formal WCAG compliance target, but be sensible: maintain readable contrast
ratios, support keyboard navigation, respect `prefers-reduced-motion`, use
semantic HTML, and ensure screen reader compatibility for interactive elements
via Melt UI's built-in ARIA handling.
