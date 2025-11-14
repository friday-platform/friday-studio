import { assertEquals } from "@std/assert";

Deno.test("workspace file name extraction", () => {
  const filePath = "/Users/test/.atlas/workspaces/my-workspace/workspace.yml";
  const fileName = filePath.split("/").pop() || "";
  assertEquals(fileName, "workspace.yml");
});

Deno.test("workspace path extraction from workspace.yml", () => {
  const filePath = "/Users/test/.atlas/workspaces/my-workspace/workspace.yml";
  const wsPath = filePath.substring(0, filePath.lastIndexOf("/"));
  assertEquals(wsPath, "/Users/test/.atlas/workspaces/my-workspace");
});

Deno.test("non-workspace.yml file detection", () => {
  const filePath = "/some/path/random-file.txt";
  const fileName = filePath.split("/").pop() || "";
  assertEquals(fileName === "workspace.yml", false);
});

Deno.test("eph_workspace.yml file detection", () => {
  const filePath = "/some/path/eph_workspace.yml";
  const fileName = filePath.split("/").pop() || "";
  assertEquals(fileName === "workspace.yml", false);
});
