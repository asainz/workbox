import { describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as gitModule from "./git";
import {
  createWorktree,
  getManagedWorktrees,
  getWorkboxWorktree,
  getWorkboxWorktrees,
  getWorktreeStatus,
  removeWorktree,
} from "./git";

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
    env: process.env,
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
    env: process.env,
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
};

const withRepo = async (fn: (repoRoot: string) => Promise<void>) => {
  const repoRoot = await mkdtemp(join(tmpdir(), "workbox-git-"));
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

describe("core/git worktrees", () => {
  it("initializes submodules when creating a managed worktree", async () => {
    const originalAllowProtocol = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = "file";

    try {
      const submoduleRoot = await mkdtemp(join(tmpdir(), "workbox-submodule-"));
      try {
        await runGit(["init"], submoduleRoot);
        await runGit(["config", "user.email", "test@example.com"], submoduleRoot);
        await runGit(["config", "user.name", "Test"], submoduleRoot);
        await writeFile(join(submoduleRoot, "submodule.txt"), "submodule\n");
        await runGit(["add", "submodule.txt"], submoduleRoot);
        await runGit(["commit", "-m", "init submodule"], submoduleRoot);

        await withRepo(async (repoRoot) => {
          await runGit(["submodule", "add", submoduleRoot, "deps/submodule"], repoRoot);
          await runGit(["commit", "-am", "add submodule"], repoRoot);

          const worktreesDir = join(repoRoot, ".workbox", "worktrees");
          const branchPrefix = "wkb/";

          const created = await createWorktree({
            repoRoot,
            worktreesDir,
            branchPrefix,
            baseRef: "HEAD",
            name: "box1",
          });

          expect(await readFile(join(created.path, "deps/submodule/submodule.txt"), "utf8")).toBe(
            "submodule\n"
          );
          expect(await runGit(["submodule", "status"], created.path)).not.toStartWith("-");
        });
      } finally {
        await rm(submoduleRoot, { recursive: true, force: true });
      }
    } finally {
      if (originalAllowProtocol === undefined) {
        delete process.env.GIT_ALLOW_PROTOCOL;
      } else {
        process.env.GIT_ALLOW_PROTOCOL = originalAllowProtocol;
      }
    }
  });

  it("creates, lists, statuses, and removes a managed worktree without deleting the branch", async () => {
    await withRepo(async (repoRoot) => {
      const worktreesDir = join(repoRoot, ".workbox", "worktrees");
      const branchPrefix = "wkb/";

      const created = await createWorktree({
        repoRoot,
        worktreesDir,
        branchPrefix,
        baseRef: "HEAD",
        name: "box1",
      });

      expect(created.branch).toBe("wkb/box1");
      expect(created.path).toBe(await realpath(join(worktreesDir, "box1")));
      expect(await gitSucceeds(["show-ref", "--verify", "refs/heads/wkb/box1"], repoRoot)).toBe(
        true
      );

      const listed = await getManagedWorktrees({ repoRoot, worktreesDir, branchPrefix });
      expect(listed.map((item) => item.name)).toEqual(["box1"]);

      const status = await getWorktreeStatus({ repoRoot, worktreesDir, branchPrefix });
      expect(status).toHaveLength(1);
      expect(status[0]?.clean).toBe(true);

      await removeWorktree({
        repoRoot,
        worktreesDir,
        branchPrefix,
        name: "box1",
        force: false,
      });

      expect(await gitSucceeds(["show-ref", "--verify", "refs/heads/wkb/box1"], repoRoot)).toBe(
        true
      );
      expect(await getManagedWorktrees({ repoRoot, worktreesDir, branchPrefix })).toEqual([]);
    });
  });

  it("can remove a detached worktree in the workbox directory", async () => {
    await withRepo(async (repoRoot) => {
      const worktreesDir = join(repoRoot, ".workbox", "worktrees");
      const branchPrefix = "wkb/";

      const created = await createWorktree({
        repoRoot,
        worktreesDir,
        branchPrefix,
        baseRef: "HEAD",
        name: "box1",
      });

      await runGit(["checkout", "--detach"], created.path);

      expect(await getManagedWorktrees({ repoRoot, worktreesDir, branchPrefix })).toEqual([]);

      const all = await getWorkboxWorktrees({ repoRoot, worktreesDir, branchPrefix });
      expect(all).toHaveLength(1);
      expect(all[0]?.branch).toBeNull();
      expect(all[0]?.managed).toBe(false);

      await removeWorktree({
        repoRoot,
        worktreesDir,
        branchPrefix,
        name: "box1",
        force: false,
      });

      expect(await gitSucceeds(["show-ref", "--verify", "refs/heads/wkb/box1"], repoRoot)).toBe(
        true
      );
      expect(await getWorkboxWorktrees({ repoRoot, worktreesDir, branchPrefix })).toEqual([]);
    });
  });

  it("rejects a worktreesDir that escapes the repo via symlink", async () => {
    await withRepo(async (repoRoot) => {
      const outside = await mkdtemp(join(tmpdir(), "workbox-outside-"));
      try {
        await symlink(outside, join(repoRoot, ".workbox"));
        await expect(
          createWorktree({
            repoRoot,
            worktreesDir: join(repoRoot, ".workbox", "worktrees"),
            branchPrefix: "wkb/",
            baseRef: "HEAD",
            name: "box1",
          })
        ).rejects.toThrow(/escapes repo root via symlink/);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("rejects invalid worktree names", async () => {
    await withRepo(async (repoRoot) => {
      const worktreesDir = join(repoRoot, ".workbox", "worktrees");
      const branchPrefix = "wkb/";
      const cases = [
        { name: "", message: /non-empty/ },
        { name: ".", message: /Invalid worktree name/ },
        { name: "bad/name", message: /Invalid worktree name/ },
        { name: "bad..name", message: /Invalid worktree name/ },
      ];

      for (const testCase of cases) {
        await expect(
          createWorktree({
            repoRoot,
            worktreesDir,
            branchPrefix,
            baseRef: "HEAD",
            name: testCase.name,
          })
        ).rejects.toThrow(testCase.message);
      }
    });
  });

  it("rejects invalid managed branch names", async () => {
    await withRepo(async (repoRoot) => {
      await expect(
        createWorktree({
          repoRoot,
          worktreesDir: join(repoRoot, ".workbox", "worktrees"),
          branchPrefix: "wkb/~",
          baseRef: "HEAD",
          name: "box1",
        })
      ).rejects.toThrow(/Invalid branch name/);
    });
  });

  it("rejects missing base refs", async () => {
    await withRepo(async (repoRoot) => {
      await expect(
        createWorktree({
          repoRoot,
          worktreesDir: join(repoRoot, ".workbox", "worktrees"),
          branchPrefix: "wkb/",
          baseRef: "missing-ref",
          name: "box1",
        })
      ).rejects.toThrow(/Base ref "missing-ref" does not exist/);
    });
  });

  it("rejects existing managed branches", async () => {
    await withRepo(async (repoRoot) => {
      await runGit(["branch", "wkb/box1"], repoRoot);

      await expect(
        createWorktree({
          repoRoot,
          worktreesDir: join(repoRoot, ".workbox", "worktrees"),
          branchPrefix: "wkb/",
          baseRef: "HEAD",
          name: "box1",
        })
      ).rejects.toThrow(/already exists/);
    });
  });

  it("rejects unknown worktrees", async () => {
    await withRepo(async (repoRoot) => {
      await expect(
        getWorkboxWorktree({
          repoRoot,
          worktreesDir: join(repoRoot, ".workbox", "worktrees"),
          branchPrefix: "wkb/",
          name: "missing",
        })
      ).rejects.toThrow(/No workbox worktree found/);
    });
  });

  it("detects path mismatches between listing and lookup", async () => {
    await withRepo(async (repoRoot) => {
      const worktreesDir = join(repoRoot, ".workbox", "worktrees");
      const branchPrefix = "wkb/";
      await createWorktree({
        repoRoot,
        worktreesDir,
        branchPrefix,
        baseRef: "HEAD",
        name: "box1",
      });

      const outside = await mkdtemp(join(tmpdir(), "workbox-outside-"));
      const original = gitModule.getWorkboxWorktrees;
      const spy = spyOn(gitModule, "getWorkboxWorktrees").mockImplementation(async (input) => {
        const items = await original(input);
        const item = items.find((entry) => entry.name === "box1");
        if (item) {
          await rm(item.path, { recursive: true, force: true });
          await symlink(outside, item.path);
        }
        return items;
      });

      try {
        await expect(
          gitModule.getWorkboxWorktree({
            repoRoot,
            worktreesDir,
            branchPrefix,
            name: "box1",
          })
        ).rejects.toThrow(/path mismatch/);
      } finally {
        spy.mockRestore();
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("returns status for a named worktree", async () => {
    await withRepo(async (repoRoot) => {
      const worktreesDir = join(repoRoot, ".workbox", "worktrees");
      const branchPrefix = "wkb/";
      const created = await createWorktree({
        repoRoot,
        worktreesDir,
        branchPrefix,
        baseRef: "HEAD",
        name: "box1",
      });
      await writeFile(join(created.path, "dirty.txt"), "dirty\n");

      const status = await getWorktreeStatus({
        repoRoot,
        worktreesDir,
        branchPrefix,
        name: "box1",
      });
      expect(status).toHaveLength(1);
      expect(status[0]?.clean).toBe(false);
    });
  });

  it("handles missing worktrees directories", async () => {
    await withRepo(async (repoRoot) => {
      const worktreesDir = join(repoRoot, ".workbox", "worktrees");
      const listed = await getWorkboxWorktrees({
        repoRoot,
        worktreesDir,
        branchPrefix: "wkb/",
      });
      expect(listed).toEqual([]);
    });
  });

  it("sorts worktrees by name", async () => {
    await withRepo(async (repoRoot) => {
      const worktreesDir = join(repoRoot, ".workbox", "worktrees");
      const branchPrefix = "wkb/";
      await createWorktree({
        repoRoot,
        worktreesDir,
        branchPrefix,
        baseRef: "HEAD",
        name: "box-b",
      });
      await createWorktree({
        repoRoot,
        worktreesDir,
        branchPrefix,
        baseRef: "HEAD",
        name: "box-a",
      });

      const listed = await getWorkboxWorktrees({
        repoRoot,
        worktreesDir,
        branchPrefix,
      });
      expect(listed.map((item) => item.name)).toEqual(["box-a", "box-b"]);
    });
  });

  it("surfaces git failures when listing worktrees", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "workbox-norepo-"));
    try {
      await expect(
        getWorkboxWorktrees({
          repoRoot,
          worktreesDir: join(repoRoot, ".workbox", "worktrees"),
          branchPrefix: "wkb/",
        })
      ).rejects.toThrow(/Git command failed/);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
