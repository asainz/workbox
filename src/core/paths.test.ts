import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import {
  CONFIG_PRIMARY,
  CONFIG_SECONDARY,
  getGlobalConfigPath,
  getProjectConfigCandidatePaths,
  resolveWorktreesDir,
} from "./paths";

describe("paths", () => {
  it("builds project config candidate paths", () => {
    const cwd = "/repo";
    expect(getProjectConfigCandidatePaths(cwd)).toEqual([
      join(cwd, CONFIG_PRIMARY),
      join(cwd, CONFIG_SECONDARY),
    ]);
  });

  it("builds the XDG global config path when XDG_CONFIG_HOME is set", () => {
    expect(getGlobalConfigPath({ XDG_CONFIG_HOME: "/config" }, "/home/user")).toBe(
      join("/config", "workbox", "config.toml")
    );
  });

  it("falls back to the home workbox config path", () => {
    expect(getGlobalConfigPath({}, "/home/user")).toBe(
      join("/home/user", ".workbox", "config.toml")
    );
  });

  it("resolves worktrees directory relative to repo root", () => {
    const cwd = "/repo";
    expect(resolveWorktreesDir(".workbox/worktrees", cwd)).toBe(join(cwd, ".workbox", "worktrees"));
  });
});
