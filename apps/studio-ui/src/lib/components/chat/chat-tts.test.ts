import { describe, expect, it } from "vitest";
import { nextSpeechChunk, stripMarkdownForSpeech } from "./chat-tts.ts";

describe("stripMarkdownForSpeech", () => {
  it("removes bold, italic, and strikethrough markers", () => {
    expect(stripMarkdownForSpeech("this is **bold** and *italic* and ~~gone~~"))
      .toBe("this is bold and italic and gone");
  });

  it("replaces fenced code with a short spoken placeholder", () => {
    const input = "before\n```ts\nconst x = 1;\n```\nafter";
    expect(stripMarkdownForSpeech(input)).toBe("before (code block) after");
  });

  it("drops inline code and image alt-text entirely", () => {
    expect(stripMarkdownForSpeech("use `fetch()` and ![cat](a.png) today"))
      .toBe("use and today");
  });

  it("keeps link text, drops the URL", () => {
    expect(stripMarkdownForSpeech("see [the docs](https://x.example) now"))
      .toBe("see the docs now");
  });

  it("removes heading hashes, bullets, and quote markers", () => {
    const input = "# Title\n- one\n- two\n> quoted\n1. first";
    // stripMarkdownForSpeech collapses runs of whitespace
    expect(stripMarkdownForSpeech(input)).toBe("Title one two quoted first");
  });
});

describe("nextSpeechChunk", () => {
  it("returns nothing when offset already covers the text", () => {
    const r = nextSpeechChunk("hello.", 6);
    expect(r.speak).toBe("");
    expect(r.nextOffset).toBe(6);
  });

  it("waits for a sentence boundary before speaking", () => {
    const r = nextSpeechChunk("hello there", 0);
    expect(r.speak).toBe("");
    expect(r.nextOffset).toBe(0);
  });

  it("peels off one complete sentence", () => {
    const r = nextSpeechChunk("Hi there. More coming", 0);
    expect(r.speak).toBe("Hi there.");
    expect(r.nextOffset).toBe("Hi there.".length);
  });

  it("peels off multiple sentences up to the last boundary", () => {
    const r = nextSpeechChunk("One. Two! Three? tail", 0);
    expect(r.speak).toBe("One. Two! Three?");
    expect(r.nextOffset).toBe("One. Two! Three?".length);
  });

  it("resumes from the provided offset on the next call", () => {
    // First pass speaks everything through the last boundary in one chunk.
    const first = nextSpeechChunk("Alpha. Bravo.", 0);
    expect(first.speak).toBe("Alpha. Bravo.");
    expect(first.nextOffset).toBe("Alpha. Bravo.".length);

    // When new tokens arrive without a boundary, the next call returns
    // nothing speakable yet and parks at the same offset.
    const second = nextSpeechChunk("Alpha. Bravo. Charlie", first.nextOffset);
    expect(second.speak).toBe("");
    expect(second.nextOffset).toBe(first.nextOffset);

    // Once the new sentence terminates, it's peeled off on the next call.
    const third = nextSpeechChunk("Alpha. Bravo. Charlie.", first.nextOffset);
    expect(third.speak).toBe("Charlie.");
    expect(third.nextOffset).toBe("Alpha. Bravo. Charlie.".length);
  });

  it("treats a newline as a sentence boundary (list items, paragraphs)", () => {
    const r = nextSpeechChunk("- step one\n- step two\ntrailing", 0);
    // Markdown bullets are stripped; the first two lines become spoken text.
    expect(r.speak).toBe("step one step two");
    // Offset points past the second newline.
    expect(r.nextOffset).toBe("- step one\n- step two\n".length);
  });

  it("strips markdown from the produced chunk", () => {
    const r = nextSpeechChunk("Here is **bold**. Next tail", 0);
    expect(r.speak).toBe("Here is bold.");
  });
});
