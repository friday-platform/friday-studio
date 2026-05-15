import { describe, expect, it } from "vitest";
import { artifactZipPath, slugifyZipBasename } from "./artifact-zip-path.ts";

describe("artifactZipPath", () => {
  it("produces a relative assets path with a slugged filename", () => {
    expect(
      artifactZipPath({
        id: "art-1",
        mimeType: "image/png",
        originalName: "diagram.png",
        title: "Diagram",
      }),
    ).toBe("assets/artifacts/art-1/diagram.png");
  });

  it("slugifies hostile ids so zip entries cannot escape assets/artifacts", () => {
    const path = artifactZipPath({
      id: "../../etc/passwd",
      mimeType: "text/plain",
      originalName: "x.txt",
      title: "Untitled",
    });

    expect(path).toBe("assets/artifacts/.._.._etc_passwd/x.txt");
    expect(path).not.toMatch(/(^|\/)\.\.(\/|$)/);
  });

  it.each([".", "..", "....."])("collapses pure-dot ids to the artifact default", (id) => {
    const path = artifactZipPath({
      id,
      mimeType: "text/plain",
      originalName: "x.txt",
      title: "Untitled",
    });

    expect(path).toBe("assets/artifacts/artifact/x.txt");
    expect(path).not.toMatch(/(^|\/)\.+(\/|$)/);
  });
});

describe("slugifyZipBasename", () => {
  it("preserves legitimate filenames containing dots", () => {
    expect(slugifyZipBasename(".env.local")).toBe(".env.local");
    expect(slugifyZipBasename("archive.tar.gz")).toBe("archive.tar.gz");
  });

  it("rewrites disallowed characters and rejects pure-dot input", () => {
    expect(slugifyZipBasename("a/b\\c.d")).toBe("a_b_c.d");
    expect(slugifyZipBasename("..")).toBe("artifact");
  });
});
