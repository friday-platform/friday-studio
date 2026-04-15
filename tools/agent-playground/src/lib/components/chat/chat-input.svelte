<script lang="ts">
  interface Props {
    disabled?: boolean;
    onsubmit: (message: string) => void;
  }

  const { disabled = false, onsubmit }: Props = $props();

  let value = $state("");

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && value.trim().length > 0 && !disabled) {
      e.preventDefault();
      onsubmit(value.trim());
      value = "";
    }
  }

  function handleSubmitClick() {
    if (value.trim().length > 0 && !disabled) {
      onsubmit(value.trim());
      value = "";
    }
  }
</script>

<div class="chat-input-wrapper">
  <textarea
    data-testid="chat-input"
    bind:value
    onkeydown={handleKeydown}
    {disabled}
    placeholder="Send a message..."
    rows={1}
  ></textarea>
  <button
    class="send-button"
    disabled={disabled || value.trim().length === 0}
    onclick={handleSubmitClick}
    aria-label="Send message"
  >
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M14 2L7 9M14 2L9.5 14L7 9M14 2L2 6.5L7 9"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>
</div>

<style>
  .chat-input-wrapper {
    align-items: flex-end;
    background-color: var(--color-surface-3);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    gap: var(--size-2);
    padding: var(--size-2) var(--size-3);
  }

  textarea {
    background: transparent;
    border: none;
    color: var(--color-text);
    flex: 1;
    font-family: inherit;
    font-size: var(--font-size-2);
    line-height: 1.5;
    min-block-size: var(--size-6);
    outline: none;
    resize: none;
  }

  textarea::placeholder {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
  }

  textarea:disabled {
    opacity: 0.5;
  }

  .send-button {
    align-items: center;
    background-color: var(--color-primary);
    border: none;
    border-radius: var(--radius-2);
    block-size: var(--size-7);
    color: white;
    cursor: pointer;
    display: flex;
    flex-shrink: 0;
    inline-size: var(--size-7);
    justify-content: center;
    transition: opacity 150ms ease;
  }

  .send-button:disabled {
    cursor: default;
    opacity: 0.4;
  }

  .send-button:not(:disabled):hover {
    opacity: 0.85;
  }
</style>
