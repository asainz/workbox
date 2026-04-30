import { z } from "zod";

import { ConfigError } from "../ui/errors";
import { checkPathWithinRoot } from "./path";
import {
  CONFIG_PRIMARY,
  CONFIG_SECONDARY,
  getConfigCandidatePaths,
  resolveWorktreesDir,
} from "./paths";

const BootstrapStepSchema = z
  .object({
    name: z.string().min(1, "Step name is required."),
    run: z.string().min(1, "Step command is required."),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const BootstrapSchema = z
  .object({
    enabled: z.boolean(),
    steps: z.array(BootstrapStepSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.steps.forEach((step, index) => {
      if (seen.has(step.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "name"],
          message: `Duplicate bootstrap step name "${step.name}".`,
        });
      }
      seen.add(step.name);
    });
  });

const WorktreesSchema = z
  .object({
    directory: z.string().min(1, "Worktree directory is required."),
    branch_prefix: z.string().min(1, "Worktree branch prefix is required."),
    base_ref: z.string().min(1, "Worktree base ref must be non-empty.").optional(),
  })
  .strict();

const WorkboxConfigSchema = z
  .object({
    worktrees: WorktreesSchema,
    bootstrap: BootstrapSchema,
    dev: z
      .object({
        command: z.string().min(1, "Dev command is required."),
        open: z.string().min(1, "Dev open command must be non-empty.").optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type WorkboxConfig = z.infer<typeof WorkboxConfigSchema>;

export type ResolvedWorkboxConfig = WorkboxConfig & {
  worktrees: WorkboxConfig["worktrees"] & { directory: string };
};

type LoadedConfig = {
  config: ResolvedWorkboxConfig;
  path: string;
};

const formatZodError = (error: z.ZodError, filePath: string): string => {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });

  return `Invalid workbox config in ${filePath}:\n${issues.map((item) => `- ${item}`).join("\n")}`;
};

const parseConfig = (source: string, filePath: string): WorkboxConfig => {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Invalid TOML in ${filePath}: ${message}`, { cause: error });
  }

  const result = WorkboxConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error, filePath));
  }

  return result.data;
};

const resolveConfig = async (
  config: WorkboxConfig,
  repoRoot: string
): Promise<ResolvedWorkboxConfig> => {
  const resolved = resolveWorktreesDir(config.worktrees.directory, repoRoot);
  const within = await checkPathWithinRoot({
    rootDir: repoRoot,
    candidatePath: resolved,
    label: "worktrees.directory",
  });
  if (!within.ok) {
    throw new ConfigError(within.reason);
  }

  return {
    ...config,
    worktrees: {
      ...config.worktrees,
      directory: resolved,
    },
  };
};

export const loadConfig = async (repoRoot: string): Promise<LoadedConfig> => {
  const candidates = getConfigCandidatePaths(repoRoot);

  for (const configPath of candidates) {
    const file = Bun.file(configPath);
    if (await file.exists()) {
      const contents = await file.text();
      const config = parseConfig(contents, configPath);
      return {
        config: await resolveConfig(config, repoRoot),
        path: configPath,
      };
    }
  }

  throw new ConfigError(
    `No workbox config found. Expected ${CONFIG_PRIMARY} or ${CONFIG_SECONDARY} in ${repoRoot}.`
  );
};
