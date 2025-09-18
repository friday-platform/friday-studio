<script lang="ts">
import { getAppContext, type KeyboardModifier } from "$lib/app-context.svelte";

const ctx = getAppContext();

const modifierKeys = new Set(["shift", "meta", "alt", "control"]);

function isModifierKey(e: KeyboardEvent) {
  return modifierKeys.has(getNormalizedKey(e.key));
}

function getKeyModifiers(e: KeyboardEvent) {
  let modifiers: KeyboardModifier[] = [];

  if (e.altKey) {
    modifiers = [...modifiers, "option"];
  }

  if (e.metaKey) {
    modifiers = [...modifiers, "command"];
  }

  if (e.shiftKey) {
    modifiers = [...modifiers, "shift"];
  }

  if (e.ctrlKey) {
    modifiers = [...modifiers, "control"];
  }

  return modifiers;
}

// holding the shift key and typing a letter will save its uppercase variant,
// this function normalizes all A-Z and a-z keys as lowercase
function getNormalizedKey(key: string) {
  return key.toLowerCase();
}

function onKeyDown(e: KeyboardEvent) {
  const key = getNormalizedKey(e.key);

  try {
    const target = e.target as HTMLElement;

    if (target.tagName === "TEXTAREA") {
      return;
    }

    if (
      target.tagName === "INPUT" &&
      target.getAttribute("type") !== "checkbox" &&
      target.getAttribute("type") !== "radio"
    ) {
      return;
    }
  } catch (error) {
    console.error(error);
  }

  if (
    key === "a" &&
    (ctx.keyboard.state?.modifiers.includes("command") ||
      ctx.keyboard.state?.modifiers.includes("control"))
  ) {
    e.preventDefault();
  }

  ctx.keyboard.update({
    key: isModifierKey(e) ? null : key,
    modifiers: getKeyModifiers(e),
    pressing: true,
  });
}

function onKeyUp(e: KeyboardEvent) {
  const key = getNormalizedKey(e.key);
  if (
    key === "a" &&
    (ctx.keyboard.state?.modifiers.includes("command") ||
      ctx.keyboard.state?.modifiers.includes("control"))
  ) {
    e.preventDefault();
  }

  ctx.keyboard.update({
    key: isModifierKey(e) ? null : key,
    modifiers: getKeyModifiers(e),
    pressing: false,
  });
}
</script>

<svelte:window onkeydown={onKeyDown} onkeyup={onKeyUp} />
