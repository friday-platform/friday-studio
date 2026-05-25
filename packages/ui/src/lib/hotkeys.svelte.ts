/**
 * Global keyboard shortcut registry.
 *
 * Single window-level keydown listener that dispatches to registered
 * bindings in stack order (last-registered wins). Lazy: the window
 * listener only attaches while at least one binding is registered, and
 * detaches when the last one is disposed.
 *
 * When two bindings share a combo, the dispatcher walks the stack from
 * top to bottom and fires the first match whose `when()` is truthy.
 * Earlier registrations never run for a combo a later registration also
 * claims — except when the later one's `when()` returns false, in which
 * case dispatch falls through to the next match.
 *
 * @module
 */

import { getContext, setContext } from "svelte";

const CONTEXT_KEY = Symbol("hotkey-registry");

export interface HotkeyBinding {
  /** KeyboardEvent.key value. Single-character keys match case-insensitively. */
  key: string;
  /** Cmd on Mac, Ctrl elsewhere. Mutually exclusive with `meta`/`ctrl`. */
  cmdOrCtrl?: boolean;
  /** Strictly Ctrl. Mac users get Ctrl, not Cmd. */
  ctrl?: boolean;
  /** Strictly Cmd (Meta). */
  meta?: boolean;
  /** Default false — Shift must NOT be pressed. */
  shift?: boolean;
  /** Default false — Alt must NOT be pressed. */
  alt?: boolean;
  /**
   * Reactive gate. Bindings whose `when` returns false are skipped; the
   * dispatcher continues walking down the stack to the next match.
   */
  when?: (e: KeyboardEvent) => boolean;
  /** Default true. */
  preventDefault?: boolean;
  handler: (e: KeyboardEvent) => void;
}

export interface HotkeyRegistry {
  /**
   * Register a binding. Returns a disposer; call it (or return it from a
   * `$effect`) to remove the binding. The window listener detaches when
   * no bindings remain.
   */
  register(binding: HotkeyBinding): () => void;
}

export function createHotkeyRegistry(): HotkeyRegistry {
  const bindings: HotkeyBinding[] = [];
  let listener: ((e: KeyboardEvent) => void) | null = null;

  function ensureListener() {
    if (listener || typeof window === "undefined") return;
    listener = handle;
    window.addEventListener("keydown", listener);
  }

  function detachListener() {
    if (!listener || typeof window === "undefined") return;
    window.removeEventListener("keydown", listener);
    listener = null;
  }

  function handle(e: KeyboardEvent) {
    for (let i = bindings.length - 1; i >= 0; i--) {
      const b = bindings[i];
      if (!b) continue;
      if (!matches(b, e)) continue;
      if (b.when && !b.when(e)) continue;
      if (b.preventDefault !== false) e.preventDefault();
      // A throwing handler must not propagate out of the window listener:
      // the event is already consumed (preventDefault ran), and an
      // uncaught throw would break dispatch for every later keystroke.
      try {
        b.handler(e);
      } catch (err) {
        console.error("hotkey handler threw", err);
      }
      return;
    }
  }

  function register(binding: HotkeyBinding): () => void {
    bindings.push(binding);
    ensureListener();
    return () => {
      const idx = bindings.lastIndexOf(binding);
      if (idx >= 0) bindings.splice(idx, 1);
      if (bindings.length === 0) detachListener();
    };
  }

  return { register };
}

function matches(b: HotkeyBinding, e: KeyboardEvent): boolean {
  if (!matchesKey(b.key, e.key)) return false;

  const wantShift = b.shift === true;
  const wantAlt = b.alt === true;
  if (e.shiftKey !== wantShift) return false;
  if (e.altKey !== wantAlt) return false;

  if (b.cmdOrCtrl) {
    // Either modifier (or both) satisfies cmdOrCtrl. Matches the common
    // `e.metaKey || e.ctrlKey` idiom used throughout the codebase.
    if (!(e.metaKey || e.ctrlKey)) return false;
  } else {
    const wantMeta = b.meta === true;
    const wantCtrl = b.ctrl === true;
    if (e.metaKey !== wantMeta) return false;
    if (e.ctrlKey !== wantCtrl) return false;
  }
  return true;
}

function matchesKey(bindingKey: string, eventKey: string): boolean {
  // Single-character keys match case-insensitively: a Shift+D binding
  // declares `key: "d"`, but the browser delivers `e.key === "D"` because
  // Shift is held. Lowercasing both sides papers over that.
  if (bindingKey.length === 1) {
    return bindingKey.toLowerCase() === eventKey.toLowerCase();
  }
  return bindingKey === eventKey;
}

/**
 * Common `when` predicate: skip the binding when the user is typing in a
 * text field (input, textarea, select, contentEditable). Useful for
 * single-letter shortcuts that would otherwise eat keystrokes the user
 * is trying to put into a form.
 */
export function notInTextField(e: KeyboardEvent): boolean {
  const t = e.target;
  if (t instanceof HTMLInputElement) return false;
  if (t instanceof HTMLTextAreaElement) return false;
  if (t instanceof HTMLSelectElement) return false;
  if (t instanceof HTMLElement && t.isContentEditable) return false;
  return true;
}

export function setHotkeyRegistry(): HotkeyRegistry {
  const registry = createHotkeyRegistry();
  setContext(CONTEXT_KEY, registry);
  return registry;
}

export function getHotkeyRegistry(): HotkeyRegistry {
  const ctx = getContext<HotkeyRegistry | undefined>(CONTEXT_KEY);
  if (!ctx) {
    throw new Error(
      "HotkeyRegistry not found. Call setHotkeyRegistry() in the root layout.",
    );
  }
  return ctx;
}
