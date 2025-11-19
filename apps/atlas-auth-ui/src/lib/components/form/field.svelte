<script lang="ts">
import { hasContext, type Snippet } from "svelte";
import { createFieldContext, FORM_CONTEXT, getContext } from "./context";
import type { Layout } from "./types";

type Props = {
  children: Snippet<[string]>;
  label?: string;
  error?: string;
  labelSnippet?: Snippet;
  description?: string;
  isRequired?: boolean;
  layout?: Layout;
  align?: "left" | "center" | "end" | "inherit";
};

let {
  children,
  error,
  label,
  labelSnippet,
  description,
  layout,
  isRequired,
  align = "inherit",
}: Props = $props();

let contextLayout: Layout = "inline";

if (hasContext(FORM_CONTEXT)) {
  contextLayout = getContext().layout;
}

function getLayoutForField() {
  if (layout) {
    return `layout-${layout}`;
  }

  return `layout-${contextLayout}`;
}

const { id } = createFieldContext();
</script>

<div class="tempest-component__form-field align--{align} {getLayoutForField()}">
  <div class="detail hasDescription-{Boolean(description)}">
    <span class="label">
      {#if labelSnippet}
        {@render labelSnippet()}
      {:else if label}
        <label for={id}>
          {label}
        </label>
      {/if}
      {#if isRequired}
        <span class="required">*</span>
      {/if}
    </span>

    {#if description}
      <span class="description">{description}</span>
    {/if}
  </div>

  <div class="control">
    {@render children(id)}

    {#if error}<div class="invalid">{error}</div>{/if}
  </div>
</div>

<style>
  .tempest-component__form-field {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    grid-column: 1 / -1;
    inline-size: 100%;

    &.layout-inline {
      @media (min-width: 640px) {
        /* align-items: center; */
        display: grid;
        grid-template-columns: subgrid;
        inline-size: 100%;
      }
    }

    .detail {
      &.hasDescription-false {
        align-items: center;
        display: flex;
      }
    }

    .label {
      display: flex;
      font-weight: var(--font-weight-5);

      .required {
        color: var(--accent-2);
      }
    }

    .description {
      color: var(--text-3);
      font-size: var(--font-size-2);
    }
  }

  :global(
    .tempest-component__form-field.layout-inline:has(
        input[type="checkbox"],
        button[role="checkbox"],
        input[type="radio"],
        button[role="radio"]
      )
  ),
  .tempest-component__form-field.align--end {
    grid-template-columns: 1fr auto;
  }

  :global(
    .tempest-component__form-field.layout-inline
      .control:has(
        input[type="checkbox"],
        button[role="checkbox"],
        input[type="radio"],
        button[role="radio"],
        [data-melt-select-trigger],
        .read-only-field
      )
  ) {
    display: flex;
    justify-content: end;
  }

  .layout-inline .control {
    inline-size: 100%;
  }

  .invalid {
    color: var(--accent-2);
    font-size: var(--font-size-2);
    word-break: break-all;
  }
</style>
