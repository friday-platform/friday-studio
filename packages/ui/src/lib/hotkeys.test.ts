/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHotkeyRegistry, notInTextField } from "./hotkeys.svelte.ts";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) {
    const d = disposers.pop();
    d?.();
  }
});

function track<T extends () => void>(dispose: T): T {
  disposers.push(dispose);
  return dispose;
}

function dispatch(opts: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { cancelable: true, ...opts });
  window.dispatchEvent(e);
  return e;
}

describe("HotkeyRegistry — stack ordering", () => {
  it("last-registered binding wins for the same combo", () => {
    const reg = createHotkeyRegistry();
    const a = vi.fn();
    const b = vi.fn();
    track(reg.register({ key: "k", cmdOrCtrl: true, handler: a }));
    track(reg.register({ key: "k", cmdOrCtrl: true, handler: b }));
    dispatch({ key: "k", metaKey: true });
    expect(b).toHaveBeenCalledOnce();
    expect(a).not.toHaveBeenCalled();
  });

  it("falls through to earlier binding when later's when() returns false", () => {
    const reg = createHotkeyRegistry();
    const a = vi.fn();
    const b = vi.fn();
    track(reg.register({ key: "k", cmdOrCtrl: true, handler: a }));
    track(
      reg.register({ key: "k", cmdOrCtrl: true, when: () => false, handler: b }),
    );
    dispatch({ key: "k", metaKey: true });
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });
});

describe("HotkeyRegistry — modifier matching", () => {
  it("cmdOrCtrl matches Cmd alone", () => {
    const reg = createHotkeyRegistry();
    const h = vi.fn();
    track(reg.register({ key: "k", cmdOrCtrl: true, handler: h }));
    dispatch({ key: "k", metaKey: true });
    expect(h).toHaveBeenCalledOnce();
  });

  it("cmdOrCtrl matches Ctrl alone", () => {
    const reg = createHotkeyRegistry();
    const h = vi.fn();
    track(reg.register({ key: "k", cmdOrCtrl: true, handler: h }));
    dispatch({ key: "k", ctrlKey: true });
    expect(h).toHaveBeenCalledOnce();
  });

  it("strict ctrl rejects pure Cmd", () => {
    const reg = createHotkeyRegistry();
    const h = vi.fn();
    track(reg.register({ key: "f", ctrl: true, handler: h }));
    dispatch({ key: "f", metaKey: true });
    expect(h).not.toHaveBeenCalled();
  });

  it("strict meta rejects pure Ctrl", () => {
    const reg = createHotkeyRegistry();
    const h = vi.fn();
    track(reg.register({ key: "f", meta: true, handler: h }));
    dispatch({ key: "f", ctrlKey: true });
    expect(h).not.toHaveBeenCalled();
  });

  it("rejects when Shift is held but the binding didn't request it", () => {
    const reg = createHotkeyRegistry();
    const h = vi.fn();
    track(reg.register({ key: "r", handler: h }));
    dispatch({ key: "r", shiftKey: true });
    expect(h).not.toHaveBeenCalled();
  });

  it("requires Shift when the binding requests it", () => {
    const reg = createHotkeyRegistry();
    const h = vi.fn();
    track(reg.register({ key: "d", cmdOrCtrl: true, shift: true, handler: h }));
    dispatch({ key: "d", metaKey: true, shiftKey: true });
    expect(h).toHaveBeenCalledOnce();
  });

  it("rejects when Alt is held but the binding didn't request it", () => {
    const reg = createHotkeyRegistry();
    const h = vi.fn();
    track(reg.register({ key: "k", cmdOrCtrl: true, handler: h }));
    dispatch({ key: "k", metaKey: true, altKey: true });
    expect(h).not.toHaveBeenCalled();
  });
});

describe("HotkeyRegistry — key matching", () => {
  it("single-char keys match case-insensitively (Shift+key delivers uppercase)", () => {
    const reg = createHotkeyRegistry();
    const h = vi.fn();
    track(reg.register({ key: "d", cmdOrCtrl: true, shift: true, handler: h }));
    dispatch({ key: "D", metaKey: true, shiftKey: true });
    expect(h).toHaveBeenCalledOnce();
  });

  it("multi-char key names are case-sensitive", () => {
    const reg = createHotkeyRegistry();
    const h = vi.fn();
    track(reg.register({ key: "Escape", handler: h }));
    dispatch({ key: "escape" });
    expect(h).not.toHaveBeenCalled();
  });
});

describe("HotkeyRegistry — preventDefault", () => {
  it("calls preventDefault by default", () => {
    const reg = createHotkeyRegistry();
    track(reg.register({ key: "k", cmdOrCtrl: true, handler: () => {} }));
    const e = dispatch({ key: "k", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
  });

  it("respects preventDefault: false", () => {
    const reg = createHotkeyRegistry();
    track(
      reg.register({
        key: "k",
        cmdOrCtrl: true,
        preventDefault: false,
        handler: () => {},
      }),
    );
    const e = dispatch({ key: "k", metaKey: true });
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("HotkeyRegistry — lifecycle", () => {
  it("disposer removes the binding", () => {
    const reg = createHotkeyRegistry();
    const h = vi.fn();
    const dispose = reg.register({ key: "k", cmdOrCtrl: true, handler: h });
    dispose();
    dispatch({ key: "k", metaKey: true });
    expect(h).not.toHaveBeenCalled();
  });

  it("attaches window listener lazily on first register and detaches after last dispose", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const reg = createHotkeyRegistry();
    expect(addSpy).not.toHaveBeenCalledWith("keydown", expect.any(Function));
    const dispose = reg.register({ key: "k", cmdOrCtrl: true, handler: () => {} });
    expect(addSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    dispose();
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});

describe("notInTextField", () => {
  function eventFor(el: Element): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { key: "/" });
    // KeyboardEvent.target is read-only without a dispatch; override for the test.
    Object.defineProperty(e, "target", { value: el, configurable: true });
    return e;
  }

  it("returns false for <input>", () => {
    expect(notInTextField(eventFor(document.createElement("input")))).toBe(false);
  });

  it("returns false for <textarea>", () => {
    expect(notInTextField(eventFor(document.createElement("textarea")))).toBe(
      false,
    );
  });

  it("returns false for <select>", () => {
    expect(notInTextField(eventFor(document.createElement("select")))).toBe(false);
  });

  it("returns false for contenteditable elements", () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    expect(notInTextField(eventFor(div))).toBe(false);
  });

  it("returns true for ordinary elements (div, button, body)", () => {
    expect(notInTextField(eventFor(document.createElement("div")))).toBe(true);
    expect(notInTextField(eventFor(document.createElement("button")))).toBe(true);
    expect(notInTextField(eventFor(document.body))).toBe(true);
  });
});
