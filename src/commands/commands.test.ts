import { describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedWorkboxConfig } from "../core/config";
import { createWorktree } from "../core/git";
import * as processModule from "../core/process";
import { UsageError } from "../ui/errors";
import { devCommand } from "./dev";
import { execCommand } from "./exec";
import { getCommand } from "./index";
import { listCommand } from "./list";
import { newCommand } from "./new";
import { pruneCommand } from "./prune";
import { setupCommand } from "./setup";
import { statusCommand } from "./status";

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

const withRepo = async (fn: (repoRoot: string) => Promise<void>) => {
  const repoRoot = await mkdtemp(join(tmpdir(), "workbox-commands-"));
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

const buildConfig = (
  repoRoot: string,
  options?: {
    baseRef?: string;
    bootstrapEnabled?: boolean;
    bootstrapSteps?: ResolvedWorkboxConfig["bootstrap"]["steps"];
    provision?: ResolvedWorkboxConfig["provision"];
    dev?: ResolvedWorkboxConfig["dev"];
  }
): ResolvedWorkboxConfig => {
  return {
    worktrees: {
      directory: join(repoRoot, ".workbox", "worktrees"),
      branch_prefix: "wkb/",
      base_ref: options?.baseRef,
    },
    bootstrap: {
      enabled: options?.bootstrapEnabled ?? false,
      steps: options?.bootstrapSteps ?? [],
    },
    provision: options?.provision ?? {
      enabled: false,
      copy: [],
      steps: [],
    },
    ...(options?.dev ? { dev: options.dev } : {}),
  };
};

const buildContext = (
  repoRoot: string,
  config: ResolvedWorkboxConfig,
  flags?: Partial<{ help: boolean; json: boolean; nonInteractive: boolean }>
) => {
  return {
    cwd: repoRoot,
    repoRoot,
    worktreeRoot: repoRoot,
    config,
    configPath: join(repoRoot, "workbox.toml"),
    flags: {
      help: false,
      json: false,
      nonInteractive: false,
      ...flags,
    },
  };
};

describe("new command", () => {
  it("requires a name", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }), {
        nonInteractive: true,
      });
      await expect(newCommand.run(context, [])).rejects.toThrow(
        "Missing worktree name in non-interactive mode."
      );
    });
  });

  it("requires a name in interactive mode", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      await expect(newCommand.run(context, [])).rejects.toThrow("Missing worktree name.");
    });
  });

  it("rejects unexpected args", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      await expect(newCommand.run(context, ["box1", "extra"])).rejects.toBeInstanceOf(UsageError);
    });
  });

  it("requires a base ref when missing", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot));
      await expect(newCommand.run(context, ["box1"])).rejects.toThrow(/Missing base ref/);
    });
  });

  it("creates a worktree using the configured base ref", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      const result = await newCommand.run(context, ["box1"]);
      expect(result.message).toContain('Created worktree "box1"');
    });
  });

  it("creates a worktree with --from", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      const result = await newCommand.run(context, ["box1", "--from", "HEAD"]);
      expect(result.message).toContain('Created worktree "box1"');
    });
  });

  it("provisions configured files after creating a worktree", async () => {
    await withRepo(async (repoRoot) => {
      await writeFile(join(repoRoot, ".env"), "TOKEN=local\n");
      const context = buildContext(
        repoRoot,
        buildConfig(repoRoot, {
          baseRef: "HEAD",
          provision: {
            enabled: true,
            copy: [{ from: ".env", to: ".env", required: false }],
            steps: [],
          },
        }),
        { json: true }
      );

      const result = await newCommand.run(context, ["box1"]);
      const worktreePath = join(repoRoot, ".workbox", "worktrees", "box1");

      expect(result.exitCode).toBeUndefined();
      expect(result.data).toEqual(
        expect.objectContaining({
          worktree: expect.objectContaining({ name: "box1" }),
          provision: expect.objectContaining({ status: "ok" }),
        })
      );
      expect(await readFile(join(worktreePath, ".env"), "utf8")).toBe("TOKEN=local\n");
    });
  });

  it("keeps the worktree when provisioning fails", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(
        repoRoot,
        buildConfig(repoRoot, {
          baseRef: "HEAD",
          provision: {
            enabled: true,
            copy: [{ from: ".env", to: ".env", required: true }],
            steps: [],
          },
        }),
        { json: true }
      );

      const result = await newCommand.run(context, ["box1"]);
      const worktreePath = join(repoRoot, ".workbox", "worktrees", "box1");

      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("missing required source");
      expect(await readFile(join(worktreePath, "README.md"), "utf8")).toBe("hello\n");
    });
  });
});

describe("list command", () => {
  it("rejects unexpected args", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      await expect(listCommand.run(context, ["extra"])).rejects.toBeInstanceOf(UsageError);
    });
  });

  it("reports empty worktree lists", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      const result = await listCommand.run(context, []);
      expect(result.message).toBe("No workbox worktrees found.");
      expect(result.data).toEqual([]);
    });
  });

  it("lists detached worktrees", async () => {
    await withRepo(async (repoRoot) => {
      const config = buildConfig(repoRoot, { baseRef: "HEAD" });
      const worktree = await createWorktree({
        repoRoot,
        worktreesDir: config.worktrees.directory,
        branchPrefix: config.worktrees.branch_prefix,
        baseRef: "HEAD",
        name: "box1",
      });
      await runGit(["checkout", "--detach"], worktree.path);

      const context = buildContext(repoRoot, config);
      const result = await listCommand.run(context, []);
      expect(result.message).toContain("(detached)");
    });
  });
});

describe("status command", () => {
  it("rejects unexpected args", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      await expect(statusCommand.run(context, ["a", "b"])).rejects.toBeInstanceOf(UsageError);
    });
  });

  it("reports empty status", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      const result = await statusCommand.run(context, []);
      expect(result.message).toBe("No workbox worktrees found.");
    });
  });

  it("reports dirty status for a named worktree", async () => {
    await withRepo(async (repoRoot) => {
      const config = buildConfig(repoRoot, { baseRef: "HEAD" });
      const worktree = await createWorktree({
        repoRoot,
        worktreesDir: config.worktrees.directory,
        branchPrefix: config.worktrees.branch_prefix,
        baseRef: "HEAD",
        name: "box1",
      });
      await writeFile(join(worktree.path, "dirty.txt"), "dirty\n");

      const context = buildContext(repoRoot, config);
      const result = await statusCommand.run(context, ["box1"]);
      expect(result.message).toContain("dirty");
    });
  });
});

describe("setup command", () => {
  it("rejects unexpected args", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      await expect(setupCommand.run(context, ["extra"])).rejects.toBeInstanceOf(UsageError);
    });
  });

  it("reports disabled bootstrap", async () => {
    await withRepo(async (repoRoot) => {
      const config = buildConfig(repoRoot, {
        baseRef: "HEAD",
        bootstrapEnabled: false,
        bootstrapSteps: [{ name: "noop", run: "echo noop" }],
      });
      const context = buildContext(repoRoot, config);
      const result = await setupCommand.run(context, []);
      expect(result.message).toBe("bootstrap is disabled in config.");
    });
  });

  it("runs configured bootstrap steps", async () => {
    await withRepo(async (repoRoot) => {
      const config = buildConfig(repoRoot, {
        baseRef: "HEAD",
        bootstrapEnabled: true,
        bootstrapSteps: [{ name: "ok", run: "echo ok" }],
      });
      const context = buildContext(repoRoot, config, { json: true });
      const result = await setupCommand.run(context, []);
      expect(result.exitCode).toBe(0);
      expect(result.message).toBe("bootstrap completed.");
    });
  });
});

describe("prune command", () => {
  it("rejects unexpected args", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      await expect(pruneCommand.run(context, ["extra"])).rejects.toBeInstanceOf(UsageError);
    });
  });

  it("formats output when prune reports changes", async () => {
    const spy = spyOn(processModule, "runCommand").mockResolvedValue({
      exitCode: 0,
      stdout: "pruned",
      stderr: "",
    });
    try {
      await withRepo(async (repoRoot) => {
        const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
        const result = await pruneCommand.run(context, []);
        expect(result.message).toBe("Pruned worktree metadata:\npruned");
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("formats output when prune reports nothing", async () => {
    const spy = spyOn(processModule, "runCommand").mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    try {
      await withRepo(async (repoRoot) => {
        const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
        const result = await pruneCommand.run(context, []);
        expect(result.message).toBe("Pruned worktree metadata.");
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("exec command", () => {
  it("requires a command separator", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      await expect(execCommand.run(context, ["box1", "echo"])).rejects.toBeInstanceOf(UsageError);
    });
  });

  it("requires exactly one name before the separator", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      await expect(
        execCommand.run(context, ["box1", "extra", "--", "echo"])
      ).rejects.toBeInstanceOf(UsageError);
    });
  });

  it("requires a worktree name before the separator", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      await expect(execCommand.run(context, ["", "--", "echo"])).rejects.toThrow(
        "Missing worktree name."
      );
    });
  });

  it("requires a command after the separator", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      await expect(execCommand.run(context, ["box1", "--"])).rejects.toBeInstanceOf(UsageError);
    });
  });

  it("runs commands inside the worktree", async () => {
    await withRepo(async (repoRoot) => {
      const config = buildConfig(repoRoot, { baseRef: "HEAD" });
      await createWorktree({
        repoRoot,
        worktreesDir: config.worktrees.directory,
        branchPrefix: config.worktrees.branch_prefix,
        baseRef: "HEAD",
        name: "box1",
      });

      const context = buildContext(repoRoot, config, { json: true });
      const result = await execCommand.run(context, ["box1", "--", "echo", "ok"]);
      expect(result.exitCode).toBe(0);
      expect(result.data).toEqual(expect.objectContaining({ command: ["echo", "ok"] }));
    });
  });
});

describe("dev command", () => {
  it("requires a name", async () => {
    await withRepo(async (repoRoot) => {
      const config = buildConfig(repoRoot, {
        baseRef: "HEAD",
        dev: { command: "echo dev" },
      });
      const context = buildContext(repoRoot, config, { nonInteractive: true });
      await expect(devCommand.run(context, [])).rejects.toThrow(
        "Missing worktree name in non-interactive mode."
      );
    });
  });

  it("requires a name in interactive mode", async () => {
    await withRepo(async (repoRoot) => {
      const config = buildConfig(repoRoot, {
        baseRef: "HEAD",
        dev: { command: "echo dev" },
      });
      const context = buildContext(repoRoot, config);
      await expect(devCommand.run(context, [])).rejects.toThrow("Missing worktree name.");
    });
  });

  it("rejects unexpected args", async () => {
    await withRepo(async (repoRoot) => {
      const config = buildConfig(repoRoot, {
        baseRef: "HEAD",
        dev: { command: "echo dev" },
      });
      const context = buildContext(repoRoot, config);
      await expect(devCommand.run(context, ["box1", "extra"])).rejects.toBeInstanceOf(UsageError);
    });
  });

  it("requires dev configuration", async () => {
    await withRepo(async (repoRoot) => {
      const context = buildContext(repoRoot, buildConfig(repoRoot, { baseRef: "HEAD" }));
      await expect(devCommand.run(context, ["box1"])).rejects.toThrow(/Dev is not configured/);
    });
  });

  it("returns bootstrap failures", async () => {
    await withRepo(async (repoRoot) => {
      const config = buildConfig(repoRoot, {
        baseRef: "HEAD",
        bootstrapEnabled: true,
        bootstrapSteps: [{ name: "fail", run: "exit 3" }],
        dev: { command: "echo dev" },
      });
      await createWorktree({
        repoRoot,
        worktreesDir: config.worktrees.directory,
        branchPrefix: config.worktrees.branch_prefix,
        baseRef: "HEAD",
        name: "box1",
      });

      const context = buildContext(repoRoot, config, { json: true });
      const result = await devCommand.run(context, ["box1"]);
      expect(result.exitCode).toBe(3);
      expect(result.message).toContain("bootstrap step");
    });
  });

  it("continues when bootstrap succeeds", async () => {
    await withRepo(async (repoRoot) => {
      const config = buildConfig(repoRoot, {
        baseRef: "HEAD",
        bootstrapEnabled: true,
        bootstrapSteps: [{ name: "ok", run: "echo ok" }],
        dev: { command: "echo dev" },
      });
      await createWorktree({
        repoRoot,
        worktreesDir: config.worktrees.directory,
        branchPrefix: config.worktrees.branch_prefix,
        baseRef: "HEAD",
        name: "box1",
      });

      const context = buildContext(repoRoot, config, { json: true });
      const result = await devCommand.run(context, ["box1"]);
      expect(result.exitCode).toBe(0);
      expect(result.data).toEqual(expect.objectContaining({ dev: expect.anything() }));
    });
  });

  it("returns open command failures", async () => {
    await withRepo(async (repoRoot) => {
      const config = buildConfig(repoRoot, {
        baseRef: "HEAD",
        bootstrapEnabled: false,
        dev: { command: "echo dev", open: "exit 2" },
      });
      await createWorktree({
        repoRoot,
        worktreesDir: config.worktrees.directory,
        branchPrefix: config.worktrees.branch_prefix,
        baseRef: "HEAD",
        name: "box1",
      });

      const context = buildContext(repoRoot, config, { json: true });
      const result = await devCommand.run(context, ["box1"]);
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain("dev open command failed");
    });
  });

  it("runs the dev command", async () => {
    await withRepo(async (repoRoot) => {
      const config = buildConfig(repoRoot, {
        baseRef: "HEAD",
        bootstrapEnabled: false,
        dev: { command: "echo dev" },
      });
      await createWorktree({
        repoRoot,
        worktreesDir: config.worktrees.directory,
        branchPrefix: config.worktrees.branch_prefix,
        baseRef: "HEAD",
        name: "box1",
      });

      const context = buildContext(repoRoot, config, { json: true });
      const result = await devCommand.run(context, ["box1"]);
      expect(result.exitCode).toBe(0);
      expect(result.message).toBe("");
    });
  });
});

describe("command registry", () => {
  it("finds registered commands", () => {
    const command = getCommand("list");
    expect(command?.name).toBe("list");
    expect(getCommand("missing")).toBeUndefined();
  });
});
