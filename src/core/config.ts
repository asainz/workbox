import { z } from "zod";

import { ConfigError } from "../ui/errors";
import { checkPathWithinRoot } from "./path";
import {
  CONFIG_PRIMARY,
  CONFIG_SECONDARY,
  GLOBAL_CONFIG_FALLBACK,
  GLOBAL_CONFIG_XDG,
  getGlobalConfigPath,
  getProjectConfigCandidatePaths,
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

const BootstrapObjectSchema = z
  .object({
    enabled: z.boolean(),
    steps: z.array(BootstrapStepSchema),
  })
  .strict();

const validateBootstrapSteps = (
  steps: Array<z.infer<typeof BootstrapStepSchema>>,
  ctx: z.RefinementCtx
) => {
  const seen = new Set<string>();
  steps.forEach((step, index) => {
    if (seen.has(step.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps", index, "name"],
        message: `Duplicate bootstrap step name "${step.name}".`,
      });
    }
    seen.add(step.name);
  });
};

const BootstrapSchema = BootstrapObjectSchema.superRefine((value, ctx) => {
  validateBootstrapSteps(value.steps, ctx);
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

export type WorkboxConfig = z.infer<typeof WorkboxConfigSchema>;

const PartialWorkboxConfigSchema = z
  .object({
    worktrees: WorktreesSchema.partial().optional(),
    bootstrap: BootstrapObjectSchema.partial()
      .superRefine((value, ctx) => {
        if (value.steps) {
          validateBootstrapSteps(value.steps, ctx);
        }
      })
      .optional(),
    dev: z
      .object({
        command: z.string().min(1, "Dev command is required.").optional(),
        open: z.string().min(1, "Dev open command must be non-empty.").optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type PartialWorkboxConfig = z.infer<typeof PartialWorkboxConfigSchema>;

export type ResolvedWorkboxConfig = WorkboxConfig & {
  worktrees: WorkboxConfig["worktrees"] & { directory: string };
};

type LoadedConfig = {
  config: ResolvedWorkboxConfig;
  path: string;
};

type LoadConfigOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

const formatZodError = (error: z.ZodError, filePath: string): string => {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });

  return `Invalid workbox config in ${filePath}:\n${issues.map((item) => `- ${item}`).join("\n")}`;
};

const parseConfig = (source: string, filePath: string): PartialWorkboxConfig => {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Invalid TOML in ${filePath}: ${message}`, { cause: error });
  }

  const result = PartialWorkboxConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error, filePath));
  }

  return result.data;
};

const mergeConfig = (configs: PartialWorkboxConfig[]): PartialWorkboxConfig =>
  configs.reduce<PartialWorkboxConfig>((merged, config) => {
    if (config.worktrees) {
      merged.worktrees = {
        ...merged.worktrees,
        ...config.worktrees,
      };
    }

    if (config.bootstrap) {
      merged.bootstrap = {
        ...merged.bootstrap,
        ...config.bootstrap,
      };
    }

    if (config.dev) {
      merged.dev = {
        ...merged.dev,
        ...config.dev,
      };
    }

    return merged;
  }, {});

const validateMergedConfig = (
  config: PartialWorkboxConfig,
  sourceDescription: string
): WorkboxConfig => {
  const result = WorkboxConfigSchema.safeParse(config);
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error, sourceDescription));
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

const describeConfigSources = (paths: string[]): string =>
  paths.length === 1 ? (paths[0] ?? "workbox config") : `merged config from ${paths.join(" and ")}`;

const readConfigIfExists = async (
  configPath: string
): Promise<{ config: PartialWorkboxConfig; path: string } | undefined> => {
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    return undefined;
  }

  const contents = await file.text();
  return {
    config: parseConfig(contents, configPath),
    path: configPath,
  };
};

export const loadConfig = async (
  repoRoot: string,
  options: LoadConfigOptions = {}
): Promise<LoadedConfig> => {
  const globalPath = getGlobalConfigPath(options.env, options.homeDir);
  const projectCandidates = getProjectConfigCandidatePaths(repoRoot);
  const loadedConfigs: Array<{ config: PartialWorkboxConfig; path: string }> = [];

  const globalConfig = await readConfigIfExists(globalPath);
  if (globalConfig) {
    loadedConfigs.push(globalConfig);
  }

  for (const configPath of projectCandidates) {
    const projectConfig = await readConfigIfExists(configPath);
    if (projectConfig) {
      loadedConfigs.push(projectConfig);
      break;
    }
  }

  if (loadedConfigs.length > 0) {
    const paths = loadedConfigs.map((item) => item.path);
    const merged = mergeConfig(loadedConfigs.map((item) => item.config));
    const config = validateMergedConfig(merged, describeConfigSources(paths));
    return {
      config: await resolveConfig(config, repoRoot),
      path: paths.at(-1) ?? globalPath,
    };
  }

  throw new ConfigError(
    `No workbox config found. Expected ${GLOBAL_CONFIG_XDG} under $XDG_CONFIG_HOME, ` +
      `${GLOBAL_CONFIG_FALLBACK} under your home directory, or ${CONFIG_PRIMARY} or ` +
      `${CONFIG_SECONDARY} in ${repoRoot}.`
  );
};
