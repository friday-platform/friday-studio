/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from "vitest";
import { createDragDropState } from "./drag-drop.svelte.ts";

interface MockDataTransfer {
  types: readonly string[];
  files: ArrayLike<File> & Iterable<File>;
  dropEffect: string;
}

interface MockEvent {
  dataTransfer: MockDataTransfer | null;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function mockEvent(opts: { files?: File[]; nonFile?: boolean } = {}): MockEvent {
  const files = opts.files ?? [];
  const types = opts.nonFile ? ["text/plain"] : opts.files !== undefined ? ["Files"] : [];
  const fileList: ArrayLike<File> & Iterable<File> = {
    length: files.length,
    ...Object.fromEntries(files.map((f, i) => [i, f])),
    [Symbol.iterator]: function* () {
      yield* files;
    },
  } as ArrayLike<File> & Iterable<File>;
  let defaultPrevented = false;
  return {
    dataTransfer: {
      types,
      files: fileList,
      dropEffect: "none",
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
    preventDefault() {
      defaultPrevented = true;
    },
  };
}

function file(name = "x.txt"): File {
  return new File(["x"], name, { type: "text/plain" });
}

// Test helper — pretend MockEvent is DragEvent for the state machine's
// signature. The state machine only touches dataTransfer + preventDefault,
// so the duck-type is sufficient and we avoid happy-dom DragEvent quirks.
const asDragEvent = (e: MockEvent) => e as unknown as DragEvent;

describe("createDragDropState — drag filtering", () => {
  it("ignores drags whose dataTransfer carries no Files type", () => {
    const onFiles = vi.fn();
    const state = createDragDropState(onFiles);
    const e = mockEvent({ nonFile: true });
    state.onDragEnter(asDragEvent(e));
    expect(state.dragOver).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    state.onDrop(asDragEvent(e));
    expect(onFiles).not.toHaveBeenCalled();
  });
});

describe("createDragDropState — dragOver lifecycle", () => {
  it("flips dragOver true on enter, clears on leave", () => {
    const state = createDragDropState(vi.fn());
    state.onDragEnter(asDragEvent(mockEvent({ files: [] })));
    expect(state.dragOver).toBe(true);
    state.onDragLeave(asDragEvent(mockEvent({ files: [] })));
    expect(state.dragOver).toBe(false);
  });

  it("nested enter/leave: counter keeps dragOver true until matched", () => {
    const state = createDragDropState(vi.fn());
    state.onDragEnter(asDragEvent(mockEvent({ files: [] })));
    state.onDragEnter(asDragEvent(mockEvent({ files: [] })));
    expect(state.dragOver).toBe(true);
    state.onDragLeave(asDragEvent(mockEvent({ files: [] })));
    // Still nested — only one leave matches one of the two enters.
    expect(state.dragOver).toBe(true);
    state.onDragLeave(asDragEvent(mockEvent({ files: [] })));
    expect(state.dragOver).toBe(false);
  });

  it("drop clears dragOver even without prior leave", () => {
    const state = createDragDropState(vi.fn());
    state.onDragEnter(asDragEvent(mockEvent({ files: [] })));
    expect(state.dragOver).toBe(true);
    state.onDrop(asDragEvent(mockEvent({ files: [file()] })));
    expect(state.dragOver).toBe(false);
  });

  it("dragLeave does not underflow past zero", () => {
    const state = createDragDropState(vi.fn());
    state.onDragLeave(asDragEvent(mockEvent({ files: [] })));
    state.onDragLeave(asDragEvent(mockEvent({ files: [] })));
    state.onDragEnter(asDragEvent(mockEvent({ files: [] })));
    state.onDragLeave(asDragEvent(mockEvent({ files: [] })));
    // With the Math.max(0, …) clamp the counter rides 0 → 0 → 1 → 0, so
    // the final leave clears dragOver. Without it the counter goes
    // negative and the matched enter never brings it back to 0 — dragOver
    // would stay stuck true.
    expect(state.dragOver).toBe(false);
  });
});

describe("createDragDropState — browser-required side effects", () => {
  it("preventDefault on dragenter (required to register as drop target)", () => {
    const state = createDragDropState(vi.fn());
    const e = mockEvent({ files: [] });
    state.onDragEnter(asDragEvent(e));
    expect(e.defaultPrevented).toBe(true);
  });

  it("preventDefault on dragover (required for drop to fire)", () => {
    const state = createDragDropState(vi.fn());
    const e = mockEvent({ files: [] });
    state.onDragOver(asDragEvent(e));
    expect(e.defaultPrevented).toBe(true);
  });

  it("ignores dragover for non-file drags", () => {
    const state = createDragDropState(vi.fn());
    const e = mockEvent({ nonFile: true });
    state.onDragOver(asDragEvent(e));
    // Non-file drags (text/url) must not be preventDefault'd, or the
    // browser's own drag preview gets hijacked.
    expect(e.defaultPrevented).toBe(false);
  });

  it("sets dropEffect = copy on dragenter and dragover", () => {
    const state = createDragDropState(vi.fn());
    const enter = mockEvent({ files: [] });
    state.onDragEnter(asDragEvent(enter));
    expect(enter.dataTransfer?.dropEffect).toBe("copy");

    const over = mockEvent({ files: [] });
    state.onDragOver(asDragEvent(over));
    expect(over.dataTransfer?.dropEffect).toBe("copy");
  });
});

describe("createDragDropState — onFiles dispatch", () => {
  it("invokes onFiles with the dropped files as an array", () => {
    const onFiles = vi.fn();
    const state = createDragDropState(onFiles);
    const f1 = file("a.txt");
    const f2 = file("b.txt");
    state.onDrop(asDragEvent(mockEvent({ files: [f1, f2] })));
    expect(onFiles).toHaveBeenCalledOnce();
    const passed = onFiles.mock.calls[0]?.[0] as File[];
    expect(passed).toHaveLength(2);
    expect(passed[0]?.name).toBe("a.txt");
    expect(passed[1]?.name).toBe("b.txt");
  });

  it("does not call onFiles for an empty file list", () => {
    const onFiles = vi.fn();
    const state = createDragDropState(onFiles);
    state.onDrop(asDragEvent(mockEvent({ files: [] })));
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("calls preventDefault on drop", () => {
    const state = createDragDropState(vi.fn());
    const e = mockEvent({ files: [file()] });
    state.onDrop(asDragEvent(e));
    expect(e.defaultPrevented).toBe(true);
  });
});
