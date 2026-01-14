# Web Client

**Date revised**: August 06, 2025 **Feature**: Atlas Web Client **Type**:
Intent-Based Specification

## 1. Base Policy (Core Intent)

### Fundamental Purpose

The web client serves as a frontend access point to Atlas via a web browser.

### Core Problem Solved

Technical and non-technical users need a full featured, rich text experience
that compliments the existing CLI interface. This interface will provide
conversations with the Atlas Conversation Agent (see:
@/specs/conversation-agent.md) along with a library of documents added by both
Atlas and the user.

## 2. Architecture

### Technology

- Powered by Svelte and SvelteKit
- Modules and local development managed by Deno
- Standards enforced by Prettier, ESLint, and Deno
- Testing provided by Deno
- Typed JavaScript using TypeScript
- Vanilla CSS using variables for the design system

### User Interface

#### Core Components

- **Button**: Primary interactive element (`components/button.svelte`)
- **Loading**: Loading state indicator (`components/loading.svelte`)
- **Error**: Error state display (`components/error.svelte`)
- **Separator/Spacer**: Layout utilities (`components/separator.svelte`,
  `components/spacer.svelte`)
- **Slider**: Range input control (`components/slider.svelte`)
- **Highlight**: Text emphasis (`components/highlight.svelte`)
- **Placeholder**: Empty state placeholder (`components/placeholder.svelte`)

#### Layout & Navigation

- **App Shell**: Container, sidebar, main content area (`components/app/`)
- **Page Structure**: Header, body, content, sidebar, toolbar, CTA sections
  (`components/page/`)

#### Forms & Inputs

- **Form System**: Field groups, labels, inputs, textareas, checkboxes, radios
  (`components/form/`)
- **Select Components**: Custom select dropdowns with triggers
  (`components/select/`)
- **Form Variants**: Read-only fields, sensitive data inputs, image uploads
  (`components/form/read-only.svelte`, `components/form/sensitive.svelte`,
  `components/form/image.svelte`)
- **Native Controls**: Native checkbox implementation
  (`components/form/native-checkbox.svelte`)

#### Dialogs & Overlays

- **Dialog**: Modal dialog with header, content, footer (`components/dialog/`)
- **Alert Dialog**: Confirmation dialogs with action buttons
  (`components/alertdialog/`)
- **Popover**: Contextual content overlays (`components/popover/`)
- **Dropdown Menu**: Hierarchical menu system with search
  (`components/dropdown-menu/`)
- **Contextual Menu**: Context-specific action menus
  (`components/contextual-menu/`)
- **Image Popover**: Image preview overlay (`components/image-popover/`)
- **Tooltip**: Simple and detailed tooltip variants (`components/tooltip/`)

#### Data Display

- **Table System**: Full-featured table with sorting, filtering, pagination
  (`components/table/`)
- **Table Columns**: Specialized columns for apps, teams, resources, tags
  (`components/table/columns/`)
- **Filters**: Multi-faceted filtering with search and sort
  (`components/filters/`, `components/table/filters/`)
- **Tags**: Tag display with gradients, owners, teams (`components/tag.svelte`,
  `components/tags/`)
- **Avatar/Profile**: User avatar and profile components (`components/avatar/`,
  `components/profile/`)

#### Interactive Elements

- **Collapsible**: Expandable/collapsible content sections
  (`components/collapsible/`)
- **Segmented Control**: Tab-like segmented controls with dropdowns
  (`components/segmented-control/`)
- **Dropzone**: Drag-and-drop file upload (`components/dropzone/`)
- **Notifications**: Toast notification system (`components/notifications/`)
- **Entity Actions**: Edit and delete entity operations (`components/entity/`)
- **Integration**: Integration component (`components/integration.svelte`)

#### Icons

- **Icon Library**: Comprehensive icon set (100+ icons)
  (`components/icons/custom/`)
- **Icon Sizes**: Small, large, and custom icon variants
  (`components/icons/small/`, `components/icons/large/`)
- **Icon Wrapper**: Base icon component (`components/icon.svelte`)
- **Icon Upload**: Icon upload functionality (`components/icon-upload.svelte`)

#### Utilities

- **Keyboard Listener**: Global keyboard event handling
  (`components/keyboard-listener.svelte`)
- **Scroll Listener**: Scroll event monitoring
  (`components/scroll-listener.svelte`)
- **Paginated Scroll**: Infinite scroll pagination
  (`components/paginated-scroll.svelte`)
- **Copy Attributes**: Clipboard copy functionality
  (`components/copy-attributes.svelte`)
- **Safe Image**: Error-resistant image loading (`components/safe-image.svelte`)

### Visual Styles

#### CSS Guidelines

- ALWAYS check for a matching design system css variable in src/app.css before
  inserting a standalone value
- ALWAYS organize CSS properties alphabetically
- ALWAYS use logical properties (inline-size vs width, padding-inline-start vs
  padding-left, etc)
- NEVER add unnecessary reset values like margin: 0, padding: 0 etc

#### Design System Foundation

- **CSS Variables**: Centralized design tokens in `app.css`
- **Rem-based Sizing**: All measurements use rem units for scalability
- **Scoped Styles**: Component styles isolated to individual .svelte files
- **No Tailwind**: Vanilla CSS only - DO NOT add tailwind classes

#### Scaling System

- **Size Scale**: Dynamic sizing via `--size-scale` multiplier
- **Text Scale**: Adjustable text sizing via `--text-scale`
- **Radius Scale**: Configurable border radius via `--radius-scale`
- **Usage**: `calc(1rem * var(--size-scale))`

#### Spacing Tokens

- **Variable Pattern**: `--size-{value}` (e.g., `--size-4`, `--size-16`)
- **Micro**: `--size-0`, `--size-px`, `--size-1-5px`, `--size-0-5`,
  `--size-0-75`
- **Small**: `--size-1` through `--size-14-5` (0.25rem to 3.625rem scaled)
- **Medium**: `--size-16` through `--size-48` (4rem to 12rem scaled)
- **Large**: `--size-52` through `--size-216` (13rem to 54rem scaled)
- **Usage**: `padding: var(--size-4);`

#### Typography

- **Font Families**:
  - Sans: `--font-family-sans`
  - Monospace: `--font-family-monospace`
- **Font Sizes**: `--font-size-2` through `--font-size-7` (0.625rem to 1.5rem
  scaled)
- **Font Weights**: `--font-weight-4` (400) through `--font-weight-7` (700)
- **Line Heights**: `--font-lineheight-0` (100%) through `--font-lineheight-5`
  (200%)
- **Letter Spacing**: `--font-letterspacing-1` (0.025em) through
  `--font-letterspacing-7` (1em)
- **Usage**: `font-size: var(--font-size-3); font-weight: var(--font-weight-6);`

#### Color System

- **Backgrounds**: `--background-1` through `--background-4`
- **Text Colors**: `--text-1` through `--text-4` (with opacity)
- **Borders**: `--border-1`, `--border-2`, `--border-3` (plus solid variants
  `--border-1s`, etc.)
- **Highlights**: `--highlight-1`, `--highlight-2`, `--highlight-3` (plus solid
  `--highlight-1s`, etc.)
- **Accent Colors**: `--accent-1` through `--accent-4`
- **Usage**: `color: var(--text-2); border: 1px solid var(--border-1);`

#### Semantic Colors (OKLCH)

- **Variable Pattern**: `--color-{name}-{variant}` (e.g., `--color-red-1`,
  `--color-blue-2`)
- **Base Colors**: Red, Orange, Yellow, Olive, Green, Teal, Blue, Purple, Pink,
  Gray
- **Brand Colors**: `--blue-1`, `--orange-1`, `--red-1`, `--plum-1`,
  `--purple-1`, `--green-1`
- **Usage**: `background: var(--color-blue-1);`

#### Gradients

- **Variable Pattern**: `--gradient-{color}-{variant}` (e.g.,
  `--gradient-blue-1`, `--gradient-blue-2`)
- **Primary Gradients**: Full opacity radial gradients (suffix `-1`)
- **Secondary Gradients**: Low opacity variants for overlays (suffix `-2`)
- **Available**: Blue, Orange, Red, Plum, Purple, Green, Black, Grey
- **Usage**: `background: var(--gradient-blue-1);`

#### Border Radius

- **Variable Pattern**: `--radius-{value}` (e.g., `--radius-1`, `--radius-4`)
- **Tokens**: `--radius-1` (0.25rem) through `--radius-4` (0.75rem) scaled
- **Special**: `--radius-round` (9999px for pills/circles)
- **Usage**: `border-radius: var(--radius-2);`

#### Shadows

- **Variable Pattern**: `--shadow-{level}` (e.g., `--shadow-1`, `--shadow-4`)
- **Levels**: `--shadow-1` through `--shadow-4` (increasing prominence)
- **Solid Variants**: `--shadow-1s` (solid version without transparency)
- **Usage**: `box-shadow: var(--shadow-2);`

#### Z-Index Layers

- **Variable Pattern**: `--layer-{level}` (e.g., `--layer-0`, `--layer-5`)
- **Levels**: `--layer-0` (0) through `--layer-5` (50)
- **Popover Override**: Melt UI popovers fixed at `--layer-4`
- **Usage**: `z-index: var(--layer-3);`

#### Dark Mode Support

- **Automatic**: Uses `prefers-color-scheme` media query
- **Full Theme**: Complete color palette for dark mode
- **Adjusted Gradients**: Opacity variants for dark backgrounds

#### Accessibility

- **Reduced Motion**: CSS variable for animation control
- **Color Scheme**: Native browser color-scheme support
- **Selection Highlight**: Custom text selection color

## 3. API Calls

Use the Hono RPC client from `@atlas/client/v2` for all API calls. Never use raw
`fetch()` for daemon API endpoints.

```typescript
// Good - use the typed Hono client
import { client, parseResult } from "@atlas/client/v2";

const result = await parseResult(
  client.workspace[":workspaceId"].$get({ param: { workspaceId: id } }),
);

// For non-JSON responses (like text/yaml), use the client without parseResult
const response = await client.workspace[":workspaceId"].export.$get({ param: { workspaceId: id } });
const text = await response.text();

// Bad - don't use raw fetch for daemon APIs
const response = await fetch(`${baseUrl}/api/workspaces/${id}`);
```

## 4. Guiding Principles

- Secure
- Fast
- Accessible
- Beautiful

## 5. Amendments
