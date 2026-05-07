import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedWorkboxConfig } from "../core/config";
import { createWorktree } from "../core/git";
import { UsageError } from "../ui/errors";
import { rmCommand } from "./rm";

const readStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) {
    return "";
  }
  return new Response(stream).text();
};

const runGit = async (args: string[], cwd: string): Promise<string> => {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }

  return stdout.trim();
};

const gitSucceeds = async (args: string[], cwd: string): Promise<boolean> => {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
};

const withRepo = async (fn: (repoRoot: string) => Promise<void>) => {
  const repoRoot = await mkdtemp(join(tmpdir(), "workbox-cmd-"));
  try {
    await runGit(["init"], repoRoot);
    await runGit(["config", "user.email", "test@example.com"], repoRoot);
    await runGit(["config", "user.name", "Test"], repoRoot);
    await writeFile(join(repoRoot, "README.md"), "hello\n");
    await runGit(["add", "README.md"], repoRoot);
    await runGit(["commit", "-m", "init"], repoRoot);
    await fn(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
};

describe("rm command", () => {
  it("requires a worktree name", async () => {
    await withRepo(async (repoRoot) => {
      const config: ResolvedWorkboxConfig = {
        worktrees: {
          directory: join(repoRoot, ".workbox", "worktrees"),
          branch_prefix: "wkb/",
          base_ref: "HEAD",
        },
        bootstrap: {
          enabled: false,
          steps: [],
        },
        provision: {
          enabled: false,
          copy: [],
          steps: [],
        },
      };

      const context = {
        cwd: repoRoot,
        repoRoot,
        worktreeRoot: repoRoot,
        config,
        configPath: join(repoRoot, "workbox.toml"),
        flags: {
          help: false,
          json: false,
          nonInteractive: true,
        },
      };

      await expect(rmCommand.run(context, [])).rejects.toThrow(
        "Missing worktree name in non-interactive mode."
      );
    });
  });

  it("requires a worktree name in interactive mode", async () => {
    await withRepo(async (repoRoot) => {
      const config: ResolvedWorkboxConfig = {
        worktrees: {
          directory: join(repoRoot, ".workbox", "worktrees"),
          branch_prefix: "wkb/",
          base_ref: "HEAD",
        },
        bootstrap: {
          enabled: false,
          steps: [],
        },
        provision: {
          enabled: false,
          copy: [],
          steps: [],
        },
      };

      const context = {
        cwd: repoRoot,
        repoRoot,
        worktreeRoot: repoRoot,
        config,
        configPath: join(repoRoot, "workbox.toml"),
        flags: {
          help: false,
          json: false,
          nonInteractive: false,
        },
      };

      await expect(rmCommand.run(context, [])).rejects.toThrow("Missing worktree name.");
    });
  });

  it("rejects unexpected args", async () => {
    await withRepo(async (repoRoot) => {
      const config: ResolvedWorkboxConfig = {
        worktrees: {
          directory: join(repoRoot, ".workbox", "worktrees"),
          branch_prefix: "wkb/",
          base_ref: "HEAD",
        },
        bootstrap: {
          enabled: false,
          steps: [],
        },
        provision: {
          enabled: false,
          copy: [],
          steps: [],
        },
      };

      const context = {
        cwd: repoRoot,
        repoRoot,
        worktreeRoot: repoRoot,
        config,
        configPath: join(repoRoot, "workbox.toml"),
        flags: {
          help: false,
          json: false,
          nonInteractive: false,
        },
      };

      await expect(rmCommand.run(context, ["box1", "extra"])).rejects.toBeInstanceOf(UsageError);
    });
  });

  it("removes managed worktrees with --force", async () => {
    await withRepo(async (repoRoot) => {
      const worktreesDir = join(repoRoot, ".workbox", "worktrees");
      const branchPrefix = "wkb/";

      const config: ResolvedWorkboxConfig = {
        worktrees: {
          directory: worktreesDir,
          branch_prefix: branchPrefix,
          base_ref: "HEAD",
        },
        bootstrap: {
          enabled: false,
          steps: [],
        },
        provision: {
          enabled: false,
          copy: [],
          steps: [],
        },
      };

      await createWorktree({
        repoRoot,
        worktreesDir,
        branchPrefix,
        baseRef: "HEAD",
        name: "box1",
      });

      const context = {
        cwd: repoRoot,
        repoRoot,
        worktreeRoot: repoRoot,
        config,
        configPath: join(repoRoot, "workbox.toml"),
        flags: {
          help: false,
          json: false,
          nonInteractive: false,
        },
      };

      await rmCommand.run(context, ["box1", "--force"]);
      expect(await gitSucceeds(["show-ref", "--verify", "refs/heads/wkb/box1"], repoRoot)).toBe(
        true
      );
    });
  });

  it("deletes managed branches with --delete-branch", async () => {
    await withRepo(async (repoRoot) => {
      const worktreesDir = join(repoRoot, ".workbox", "worktrees");
      const branchPrefix = "wkb/";

      const config: ResolvedWorkboxConfig = {
        worktrees: {
          directory: worktreesDir,
          branch_prefix: branchPrefix,
          base_ref: "HEAD",
        },
        bootstrap: {
          enabled: false,
          steps: [],
        },
        provision: {
          enabled: false,
          copy: [],
          steps: [],
        },
      };

      await createWorktree({
        repoRoot,
        worktreesDir,
        branchPrefix,
        baseRef: "HEAD",
        name: "box1",
      });

      const context = {
        cwd: repoRoot,
        repoRoot,
        worktreeRoot: repoRoot,
        config,
        configPath: join(repoRoot, "workbox.toml"),
        flags: {
          help: false,
          json: false,
          nonInteractive: false,
        },
      };

      const result = await rmCommand.run(context, ["box1", "--delete-branch"]);
      expect(result.message).toContain("deleted branch wkb/box1");
      expect(await gitSucceeds(["show-ref", "--verify", "refs/heads/wkb/box1"], repoRoot)).toBe(
        false
      );
    });
  });

  it("refuses to remove unmanaged worktrees unless --unmanaged is provided", async () => {
    await withRepo(async (repoRoot) => {
      const worktreesDir = join(repoRoot, ".workbox", "worktrees");
      const branchPrefix = "wkb/";

      const config: ResolvedWorkboxConfig = {
        worktrees: {
          directory: worktreesDir,
          branch_prefix: branchPrefix,
          base_ref: "HEAD",
        },
        bootstrap: {
          enabled: false,
          steps: [],
        },
        provision: {
          enabled: false,
          copy: [],
          steps: [],
        },
      };

      const created = await createWorktree({
        repoRoot,
        worktreesDir,
        branchPrefix,
        baseRef: "HEAD",
        name: "box1",
      });

      await runGit(["checkout", "--detach"], created.path);

      const context = {
        cwd: repoRoot,
        repoRoot,
        worktreeRoot: repoRoot,
        config,
        configPath: join(repoRoot, "workbox.toml"),
        flags: {
          help: false,
          json: false,
          nonInteractive: true,
        },
      };

      await expect(rmCommand.run(context, ["box1"])).rejects.toBeInstanceOf(UsageError);
      await expect(rmCommand.run(context, ["box1"])).rejects.toThrow(/--unmanaged/);

      await rmCommand.run(context, ["box1", "--unmanaged"]);
      expect(await gitSucceeds(["show-ref", "--verify", "refs/heads/wkb/box1"], repoRoot)).toBe(
        true
      );
    });
  });

  it("refuses to delete branches for unmanaged worktrees", async () => {
    await withRepo(async (repoRoot) => {
      const worktreesDir = join(repoRoot, ".workbox", "worktrees");
      const branchPrefix = "wkb/";

      const config: ResolvedWorkboxConfig = {
        worktrees: {
          directory: worktreesDir,
          branch_prefix: branchPrefix,
          base_ref: "HEAD",
        },
        bootstrap: {
          enabled: false,
          steps: [],
        },
        provision: {
          enabled: false,
          copy: [],
          steps: [],
        },
      };

      const created = await createWorktree({
        repoRoot,
        worktreesDir,
        branchPrefix,
        baseRef: "HEAD",
        name: "box1",
      });

      await runGit(["checkout", "--detach"], created.path);

      const context = {
        cwd: repoRoot,
        repoRoot,
        worktreeRoot: repoRoot,
        config,
        configPath: join(repoRoot, "workbox.toml"),
        flags: {
          help: false,
          json: false,
          nonInteractive: true,
        },
      };

      await expect(
        rmCommand.run(context, ["box1", "--unmanaged", "--delete-branch"])
      ).rejects.toThrow(/unmanaged worktree/);
      expect(await gitSucceeds(["show-ref", "--verify", "refs/heads/wkb/box1"], repoRoot)).toBe(
        true
      );
    });
  });
});
