import { describe, expect, it } from "vitest";

describe("workspace file name extraction", () => {
  it("extracts filename from path", () => {
    const filePath = "/Users/test/.atlas/workspaces/my-workspace/workspace.yml";
    const fileName = filePath.split("/").pop() || "";
    expect(fileName).toEqual("workspace.yml");
  });
});

describe("workspace path extraction from workspace.yml", () => {
  it("extracts directory path", () => {
    const filePath = "/Users/test/.atlas/workspaces/my-workspace/workspace.yml";
    const wsPath = filePath.substring(0, filePath.lastIndexOf("/"));
    expect(wsPath).toEqual("/Users/test/.atlas/workspaces/my-workspace");
  });
});

describe("non-workspace.yml file detection", () => {
  it("detects non-workspace files", () => {
    const filePath = "/some/path/random-file.txt";
    const fileName = filePath.split("/").pop() || "";
    expect(fileName === "workspace.yml").toEqual(false);
  });
});

describe("eph_workspace.yml file detection", () => {
  it("detects ephemeral workspace files as non-standard", () => {
    const filePath = "/some/path/eph_workspace.yml";
    const fileName = filePath.split("/").pop() || "";
    expect(fileName === "workspace.yml").toEqual(false);
  });
});
