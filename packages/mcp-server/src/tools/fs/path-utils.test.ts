import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandUserPath } from "./path-utils.ts";

describe("expandUserPath", () => {
  const realHome = process.env.HOME;
  const realUser = process.env.USER;

  beforeEach(() => {
    process.env.HOME = "/home/tester";
    process.env.USER = "tester";
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUser === undefined) delete process.env.USER;
    else process.env.USER = realUser;
  });

  it("expands a bare ~ to the home directory", () => {
    expect(expandUserPath("~")).toBe("/home/tester");
  });

  it("expands a leading ~/ to a home-relative path", () => {
    expect(expandUserPath("~/bucketlist/repo")).toBe("/home/tester/bucketlist/repo");
  });

  it("leaves a literal ~name untouched (not a tilde-home reference)", () => {
    expect(expandUserPath("~weird/path")).toBe("~weird/path");
  });

  it("expands $HOME and ${HOME}", () => {
    expect(expandUserPath("$HOME/repo")).toBe("/home/tester/repo");
    expect(expandUserPath("${HOME}/repo")).toBe("/home/tester/repo");
  });

  it("expands $USER and ${USER}", () => {
    expect(expandUserPath("/Users/$USER/repo")).toBe("/Users/tester/repo");
    expect(expandUserPath("/Users/${USER}/repo")).toBe("/Users/tester/repo");
  });

  it("does not partially expand $HOMEBREW or $USERNAME", () => {
    expect(expandUserPath("/opt/$HOMEBREW/bin")).toBe("/opt/$HOMEBREW/bin");
    expect(expandUserPath("/x/$USERNAME/y")).toBe("/x/$USERNAME/y");
  });

  it("returns ordinary relative and absolute paths unchanged", () => {
    expect(expandUserPath("src/foo.ts")).toBe("src/foo.ts");
    expect(expandUserPath("/var/log/app.log")).toBe("/var/log/app.log");
  });
});
