import { access, mkdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { CliError } from "../ui/errors";
import { checkPathWithinRoot, isSubpath } from "./path";
import { runCommand } from "./process";

type WorktreeInfo = {
  name: string;
  path: string;
  branch: string | null;
  managedBranch: string;
  managed: boolean;
};

type WorktreeStatus = WorktreeInfo & {
  clean: boolean;
};

type PorcelainWorktree = {
  path: string;
  branch: string | null;
  detached: boolean;
};

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const runCmd = async (cmd: string[], cwd: string): Promise<RunResult> => {
  return runCommand({ cmd, cwd, mode: "capture" });
};

const runGit = async (args: string[], cwd: string): Promise<string> => {
  const result = await runCmd(["git", ...args], cwd);
  if (result.exitCode !== 0) {
    const message = result.stderr || result.stdout || "Unknown git error.";
    throw new CliError(`Git command failed (git ${args.join(" ")}): ${message}`);
  }
  return result.stdout.trim();
};

const gitSucceeds = async (args: string[], cwd: string): Promise<boolean> => {
  const result = await runCmd(["git", ...args], cwd);
  return result.exitCode === 0;
};

const assertValidBranchName = async (branch: string, repoRoot: string): Promise<void> => {
  const valid = await gitSucceeds(["check-ref-format", "--branch", branch], repoRoot);
  if (!valid) {
    throw new CliError(
      `Invalid branch name "${branch}". Check worktrees.branch_prefix and the sandbox name.`
    );
  }
};

const normalizePath = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const assertWorktreesDirSafe = async (repoRoot: string, worktreesDir: string): Promise<void> => {
  const within = await checkPathWithinRoot({
    rootDir: repoRoot,
    candidatePath: worktreesDir,
    label: "worktrees.directory",
  });
  if (!within.ok) {
    throw new CliError(within.reason);
  }
};

const parseWorktreeListPorcelain = (output: string): PorcelainWorktree[] => {
  const lines = output.split("\n");
  const items: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | null = null;

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      if (current) {
        items.push(current);
      }
      current = {
        path: line.slice("worktree ".length).trim(),
        branch: null,
        detached: false,
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line === "detached") {
      current.detached = true;
      current.branch = null;
      continue;
    }

    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }

  if (current) {
    items.push(current);
  }

  return items;
};

const validateWorktreeName = (name: string): void => {
  if (!name || name.trim().length === 0) {
    throw new CliError("Worktree name must be non-empty.", { exitCode: 2 });
  }
  if (name === "." || name === "..") {
    throw new CliError(`Invalid worktree name "${name}".`, { exitCode: 2 });
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new CliError(`Invalid worktree name "${name}".`, { exitCode: 2 });
  }
  if (name.includes("..")) {
    throw new CliError(`Invalid worktree name "${name}".`, { exitCode: 2 });
  }
};

const listWorktreesPorcelain = async (repoRoot: string): Promise<PorcelainWorktree[]> => {
  const output = await runGit(["worktree", "list", "--porcelain"], repoRoot);
  return parseWorktreeListPorcelain(output);
};

export const getWorkboxWorktrees = async (input: {
  repoRoot: string;
  worktreesDir: string;
  branchPrefix: string;
}): Promise<WorktreeInfo[]> => {
  await assertWorktreesDirSafe(input.repoRoot, input.worktreesDir);
  const worktrees = await listWorktreesPorcelain(input.repoRoot);
  const normalizedWorktreesDir = await normalizePath(input.worktreesDir);

  const items: WorktreeInfo[] = [];
  for (const worktree of worktrees) {
    const resolvedPath = resolve(input.repoRoot, worktree.path);
    const normalizedPath = await normalizePath(resolvedPath);

    if (!isSubpath(normalizedPath, normalizedWorktreesDir)) {
      continue;
    }

    const relativePath = relative(normalizedWorktreesDir, normalizedPath);
    if (!relativePath || relativePath === "." || relativePath.includes(sep)) {
      continue;
    }

    validateWorktreeName(relativePath);
    const name = relativePath;
    const expectedPath = await normalizePath(join(input.worktreesDir, name));

    if (expectedPath !== normalizedPath) {
      continue;
    }

    const managedBranch = `${input.branchPrefix}${name}`;
    items.push({
      name,
      path: normalizedPath,
      branch: worktree.branch,
      managedBranch,
      managed: worktree.branch === managedBranch,
    });
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
};

export const getManagedWorktrees = async (input: {
  repoRoot: string;
  worktreesDir: string;
  branchPrefix: string;
}): Promise<WorktreeInfo[]> => {
  const items = await getWorkboxWorktrees(input);
  return items.filter((item) => item.managed);
};

export const getWorkboxWorktree = async (input: {
  repoRoot: string;
  worktreesDir: string;
  branchPrefix: string;
  name: string;
}): Promise<WorktreeInfo> => {
  await assertWorktreesDirSafe(input.repoRoot, input.worktreesDir);
  validateWorktreeName(input.name);
  const expectedPath = await normalizePath(join(input.worktreesDir, input.name));

  const candidates = await getWorkboxWorktrees({
    repoRoot: input.repoRoot,
    worktreesDir: input.worktreesDir,
    branchPrefix: input.branchPrefix,
  });

  const match = candidates.find((candidate) => candidate.name === input.name);
  if (!match) {
    throw new CliError(`No workbox worktree found for "${input.name}".`);
  }

  if ((await normalizePath(match.path)) !== expectedPath) {
    throw new CliError(
      `Refusing to operate on "${input.name}": path mismatch (expected ${expectedPath}, got ${match.path}).`
    );
  }

  return match;
};

export const createWorktree = async (input: {
  repoRoot: string;
  worktreesDir: string;
  branchPrefix: string;
  baseRef: string;
  name: string;
}): Promise<WorktreeInfo> => {
  await assertWorktreesDirSafe(input.repoRoot, input.worktreesDir);
  validateWorktreeName(input.name);
  const managedBranch = `${input.branchPrefix}${input.name}`;
  const worktreePath = join(input.worktreesDir, input.name);

  await mkdir(input.worktreesDir, { recursive: true });
  await assertValidBranchName(managedBranch, input.repoRoot);

  const baseExists = await gitSucceeds(["rev-parse", "--verify", input.baseRef], input.repoRoot);
  if (!baseExists) {
    throw new CliError(`Base ref "${input.baseRef}" does not exist.`);
  }

  const branchExists = await gitSucceeds(
    ["show-ref", "--verify", `refs/heads/${managedBranch}`],
    input.repoRoot
  );
  if (branchExists) {
    throw new CliError(
      `Branch "${managedBranch}" already exists. Refusing to create a new sandbox.`
    );
  }

  await runGit(
    ["worktree", "add", "-b", managedBranch, worktreePath, input.baseRef],
    input.repoRoot
  );

  if (await pathExists(join(worktreePath, ".gitmodules"))) {
    await runGit(["submodule", "update", "--init", "--recursive"], worktreePath);
  }

  return {
    name: input.name,
    path: await normalizePath(worktreePath),
    branch: managedBranch,
    managedBranch,
    managed: true,
  };
};

export const removeWorktree = async (input: {
  repoRoot: string;
  worktreesDir: string;
  branchPrefix: string;
  name: string;
  force: boolean;
}): Promise<WorktreeInfo> => {
  await assertWorktreesDirSafe(input.repoRoot, input.worktreesDir);
  const worktree = await getWorkboxWorktree({
    repoRoot: input.repoRoot,
    worktreesDir: input.worktreesDir,
    branchPrefix: input.branchPrefix,
    name: input.name,
  });

  await runGit(
    ["worktree", "remove", ...(input.force ? ["--force"] : []), "--", worktree.path],
    input.repoRoot
  );

  return worktree;
};

export const pruneWorktrees = async (repoRoot: string): Promise<{ stdout: string }> => {
  const stdout = await runGit(["worktree", "prune"], repoRoot);
  return { stdout };
};

const isCleanWorktree = async (path: string): Promise<boolean> => {
  const status = await runGit(["status", "--porcelain"], path);
  return status.trim().length === 0;
};

export const getWorktreeStatus = async (input: {
  repoRoot: string;
  worktreesDir: string;
  branchPrefix: string;
  name?: string;
}): Promise<WorktreeStatus[]> => {
  await assertWorktreesDirSafe(input.repoRoot, input.worktreesDir);
  const worktrees = input.name
    ? [
        await getWorkboxWorktree({
          repoRoot: input.repoRoot,
          worktreesDir: input.worktreesDir,
          branchPrefix: input.branchPrefix,
          name: input.name,
        }),
      ]
    : await getWorkboxWorktrees({
        repoRoot: input.repoRoot,
        worktreesDir: input.worktreesDir,
        branchPrefix: input.branchPrefix,
      });

  const results: WorktreeStatus[] = [];
  for (const worktree of worktrees) {
    results.push({
      ...worktree,
      clean: await isCleanWorktree(worktree.path),
    });
  }
  return results;
};
