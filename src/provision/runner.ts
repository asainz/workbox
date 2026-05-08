import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { checkPathWithinRoot } from "../core/path";
import { runShellCommand } from "../core/process";
import { CliError } from "../ui/errors";

type ProvisionCopy = {
  from: string;
  to: string;
  required: boolean;
};

type ProvisionStep = {
  name: string;
  run: string;
  cwd?: string;
  env?: Record<string, string>;
};

type ProvisionCopyResult = {
  from: string;
  to: string;
  required: boolean;
  source: string;
  destination: string;
  status: "copied" | "skipped" | "failed";
  reason?: string;
};

type ProvisionStepResult = {
  name: string;
  command: string;
  cwd: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

type ProvisionResult = {
  status: "ok" | "failed";
  message: string;
  copies: ProvisionCopyResult[];
  steps: ProvisionStepResult[];
  exitCode: number;
};

type OutputMode = "inherit" | "capture";

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const resolveWithinRoot = async (rootDir: string, path: string, label: string): Promise<string> => {
  const resolved = resolve(rootDir, path);
  const within = await checkPathWithinRoot({
    rootDir,
    candidatePath: resolved,
    label,
  });
  if (!within.ok) {
    throw new CliError(within.reason, { exitCode: 2 });
  }
  return resolved;
};

const buildFailedResult = (
  message: string,
  copies: ProvisionCopyResult[],
  steps: ProvisionStepResult[],
  exitCode: number
): ProvisionResult => ({
  status: "failed",
  message,
  copies,
  steps,
  exitCode,
});

export const runProvision = async (
  provision: { copy: ProvisionCopy[]; steps: ProvisionStep[] },
  options: {
    sourceRoot: string;
    targetRoot: string;
    worktreeName: string;
    mode: OutputMode;
  }
): Promise<ProvisionResult> => {
  const copies: ProvisionCopyResult[] = [];
  const steps: ProvisionStepResult[] = [];

  if (provision.copy.length === 0 && provision.steps.length === 0) {
    return {
      status: "ok",
      message: "no provision actions configured.",
      copies,
      steps,
      exitCode: 0,
    };
  }

  for (const item of provision.copy) {
    const source = await resolveWithinRoot(options.sourceRoot, item.from, "provision copy source");
    const destination = await resolveWithinRoot(
      options.targetRoot,
      item.to,
      "provision copy destination"
    );

    let sourceStat: Awaited<ReturnType<typeof stat>>;
    try {
      sourceStat = await stat(source);
    } catch (error) {
      if (!isMissingPathError(error)) {
        const reason = getErrorMessage(error);
        copies.push({ ...item, source, destination, status: "failed", reason });
        return buildFailedResult(
          `provision copy "${item.from}" failed: ${reason}`,
          copies,
          steps,
          1
        );
      }
      if (!item.required) {
        copies.push({ ...item, source, destination, status: "skipped", reason: "missing source" });
        continue;
      }
      const reason = "missing required source";
      copies.push({ ...item, source, destination, status: "failed", reason });
      return buildFailedResult(
        `provision copy "${item.from}" failed: ${reason}.`,
        copies,
        steps,
        1
      );
    }

    if (sourceStat.isDirectory()) {
      const reason = "source is a directory";
      copies.push({ ...item, source, destination, status: "failed", reason });
      return buildFailedResult(
        `provision copy "${item.from}" failed: ${reason}.`,
        copies,
        steps,
        1
      );
    }

    try {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    } catch (error) {
      const reason = getErrorMessage(error);
      copies.push({ ...item, source, destination, status: "failed", reason });
      return buildFailedResult(`provision copy "${item.from}" failed: ${reason}`, copies, steps, 1);
    }

    copies.push({ ...item, source, destination, status: "copied" });
  }

  for (const step of provision.steps) {
    const cwd = await resolveWithinRoot(options.targetRoot, step.cwd ?? ".", "provision step cwd");
    const result = await runShellCommand({
      command: step.run,
      cwd,
      mode: options.mode,
      env: {
        WORKBOX_SOURCE: options.sourceRoot,
        WORKBOX_WORKTREE: options.targetRoot,
        WORKBOX_NAME: options.worktreeName,
        ...step.env,
      },
    });

    steps.push({
      name: step.name,
      command: step.run,
      cwd,
      exitCode: result.exitCode,
      ...(options.mode === "capture"
        ? { stdout: result.stdout.trim(), stderr: result.stderr.trim() }
        : {}),
    });

    if (result.exitCode !== 0) {
      return buildFailedResult(
        `provision step "${step.name}" failed (exit ${result.exitCode}).`,
        copies,
        steps,
        result.exitCode
      );
    }
  }

  return {
    status: "ok",
    message: "provision completed.",
    copies,
    steps,
    exitCode: 0,
  };
};
