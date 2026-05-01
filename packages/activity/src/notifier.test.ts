import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityNotifier } from "./notifier.ts";

describe("ActivityNotifier", () => {
  let notifier: ActivityNotifier;

  beforeEach(() => {
    notifier = new ActivityNotifier();
  });

  it("notify() calls all subscribed callbacks", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    notifier.subscribe(cb1);
    notifier.subscribe(cb2);

    notifier.notify();

    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it("unsubscribe removes the callback", () => {
    const cb = vi.fn();
    const unsub = notifier.subscribe(cb);

    unsub();
    notifier.notify();

    expect(cb).not.toHaveBeenCalled();
  });

  it("multiple subscribers all receive notifications", () => {
    const callbacks = [vi.fn(), vi.fn(), vi.fn()];
    for (const cb of callbacks) {
      notifier.subscribe(cb);
    }

    notifier.notify();

    for (const cb of callbacks) {
      expect(cb).toHaveBeenCalledOnce();
    }
  });

  it("unsubscribed callback is not called on subsequent notify()", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    notifier.subscribe(cb1);
    const unsub2 = notifier.subscribe(cb2);

    notifier.notify();
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();

    unsub2();
    notifier.notify();

    expect(cb1).toHaveBeenCalledTimes(2);
    expect(cb2).toHaveBeenCalledOnce();
  });
});
