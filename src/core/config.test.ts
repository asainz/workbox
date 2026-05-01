import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config";

const withTempDir = async (fn: (cwd: string) => Promise<void>) => {
  const cwd = await mkdtemp(join(tmpdir(), "workbox-"));
  try {
    await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

const minimalConfig = `[worktrees]
directory = ".workbox/worktrees"
branch_prefix = "wkb/"

[bootstrap]
enabled = false
steps = []
`;

const loadTestConfig = (cwd: string, homeDir = join(cwd, "home")) =>
  loadConfig(cwd, { env: {}, homeDir });

describe("loadConfig", () => {
  it("rejects when no config exists", async () => {
    await withTempDir(async (cwd) => {
      await expect(loadTestConfig(cwd)).rejects.toThrow(/No workbox config found/);
    });
  });

  it("prefers .workbox/config.toml over workbox.toml", async () => {
    await withTempDir(async (cwd) => {
      await mkdir(join(cwd, ".workbox"), { recursive: true });
      await writeFile(
        join(cwd, ".workbox", "config.toml"),
        minimalConfig.replace('.workbox/worktrees"', 'sandbox"')
      );
      await writeFile(
        join(cwd, "workbox.toml"),
        minimalConfig.replace('.workbox/worktrees"', 'fallback"')
      );

      const result = await loadTestConfig(cwd);
      expect(result.path).toBe(join(cwd, ".workbox", "config.toml"));
      expect(result.config.worktrees.directory).toBe(join(cwd, "sandbox"));
    });
  });

  it("loads global config from the fallback home path when no project config exists", async () => {
    await withTempDir(async (cwd) => {
      const homeDir = join(cwd, "home");
      await mkdir(join(homeDir, ".workbox"), { recursive: true });
      await writeFile(
        join(homeDir, ".workbox", "config.toml"),
        minimalConfig.replace('.workbox/worktrees"', 'global-worktrees"')
      );

      const result = await loadTestConfig(cwd, homeDir);
      expect(result.path).toBe(join(homeDir, ".workbox", "config.toml"));
      expect(result.config.worktrees.directory).toBe(join(cwd, "global-worktrees"));
    });
  });

  it("loads global config from XDG_CONFIG_HOME when it is set", async () => {
    await withTempDir(async (cwd) => {
      const configHome = join(cwd, "xdg");
      await mkdir(join(configHome, "workbox"), { recursive: true });
      await writeFile(
        join(configHome, "workbox", "config.toml"),
        minimalConfig.replace('branch_prefix = "wkb/"', 'branch_prefix = "global/"')
      );

      const result = await loadConfig(cwd, {
        env: { XDG_CONFIG_HOME: configHome },
        homeDir: join(cwd, "home"),
      });
      expect(result.path).toBe(join(configHome, "workbox", "config.toml"));
      expect(result.config.worktrees.branch_prefix).toBe("global/");
    });
  });

  it("merges project config over global config", async () => {
    await withTempDir(async (cwd) => {
      const homeDir = join(cwd, "home");
      await mkdir(join(homeDir, ".workbox"), { recursive: true });
      await mkdir(join(cwd, ".workbox"), { recursive: true });
      await writeFile(
        join(homeDir, ".workbox", "config.toml"),
        minimalConfig
          .replace('.workbox/worktrees"', 'global-worktrees"')
          .replace('branch_prefix = "wkb/"', 'branch_prefix = "global/"')
      );
      await writeFile(
        join(cwd, ".workbox", "config.toml"),
        `[worktrees]
branch_prefix = "local/"
`
      );

      const result = await loadTestConfig(cwd, homeDir);
      expect(result.path).toBe(join(cwd, ".workbox", "config.toml"));
      expect(result.config.worktrees.directory).toBe(join(cwd, "global-worktrees"));
      expect(result.config.worktrees.branch_prefix).toBe("local/");
    });
  });

  it("merges project dev config over global dev config", async () => {
    await withTempDir(async (cwd) => {
      const homeDir = join(cwd, "home");
      await mkdir(join(homeDir, ".workbox"), { recursive: true });
      await writeFile(
        join(homeDir, ".workbox", "config.toml"),
        `${minimalConfig}
[dev]
command = "bun run dev"
open = "open http://localhost:3000"
`
      );
      await writeFile(
        join(cwd, "workbox.toml"),
        `[dev]
open = "open http://localhost:4000"
`
      );

      const result = await loadTestConfig(cwd, homeDir);
      expect(result.config.dev).toEqual({
        command: "bun run dev",
        open: "open http://localhost:4000",
      });
    });
  });

  it("rejects when merged global and project config is incomplete", async () => {
    await withTempDir(async (cwd) => {
      const homeDir = join(cwd, "home");
      await mkdir(join(homeDir, ".workbox"), { recursive: true });
      await writeFile(
        join(homeDir, ".workbox", "config.toml"),
        `[worktrees]
directory = ".workbox/worktrees"
`
      );

      await expect(loadTestConfig(cwd, homeDir)).rejects.toThrow(/worktrees.branch_prefix/);
    });
  });

  it("rejects invalid project config even when global config is valid", async () => {
    await withTempDir(async (cwd) => {
      const homeDir = join(cwd, "home");
      await mkdir(join(homeDir, ".workbox"), { recursive: true });
      await writeFile(join(homeDir, ".workbox", "config.toml"), minimalConfig);
      await writeFile(join(cwd, "workbox.toml"), `[worktrees]\ndirectory = 123\n`);

      await expect(loadTestConfig(cwd, homeDir)).rejects.toThrow(/workbox\.toml/);
    });
  });

  it("rejects invalid TOML", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(join(cwd, "workbox.toml"), "=broken");
      await expect(loadTestConfig(cwd)).rejects.toThrow(/Invalid TOML/);
    });
  });

  it("rejects invalid schema types", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(
        join(cwd, "workbox.toml"),
        minimalConfig.replace('directory = ".workbox/worktrees"', "directory = 123")
      );
      await expect(loadTestConfig(cwd)).rejects.toThrow(/worktrees.directory/);
    });
  });

  it("rejects worktree directory outside the repo root", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(
        join(cwd, "workbox.toml"),
        minimalConfig.replace('directory = ".workbox/worktrees"', 'directory = "../worktrees"')
      );
      await expect(loadTestConfig(cwd)).rejects.toThrow(/must be within repo root/);
    });
  });

  it("rejects duplicate bootstrap step names", async () => {
    await withTempDir(async (cwd) => {
      const duplicateConfig = minimalConfig
        .replace(
          "steps = []",
          `steps = [
  { name = "install", run = "bun install" },
  { name = "install", run = "bun run build" }
]`
        )
        .replace("enabled = false", "enabled = true");
      await writeFile(join(cwd, "workbox.toml"), duplicateConfig);
      await expect(loadTestConfig(cwd)).rejects.toThrow(/Duplicate bootstrap step name/);
    });
  });

  it("rejects worktree directory that escapes the repo via symlink", async () => {
    await withTempDir(async (cwd) => {
      const outside = await mkdtemp(join(tmpdir(), "workbox-outside-"));
      try {
        await symlink(outside, join(cwd, ".workbox"));
        await writeFile(join(cwd, "workbox.toml"), minimalConfig);
        await expect(loadTestConfig(cwd)).rejects.toThrow(/escapes repo root via symlink/);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
