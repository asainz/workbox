import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CONFIG_PRIMARY = join(".workbox", "config.toml");
export const CONFIG_SECONDARY = "workbox.toml";
export const GLOBAL_CONFIG_XDG = join("workbox", "config.toml");
export const GLOBAL_CONFIG_FALLBACK = join(".workbox", "config.toml");

export const getGlobalConfigPath = (
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir()
): string =>
  env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, GLOBAL_CONFIG_XDG)
    : join(homeDir, GLOBAL_CONFIG_FALLBACK);

export const getProjectConfigCandidatePaths = (repoRoot: string): string[] => [
  join(repoRoot, CONFIG_PRIMARY),
  join(repoRoot, CONFIG_SECONDARY),
];

export const resolveWorktreesDir = (worktreesDir: string, repoRoot: string): string =>
  resolve(repoRoot, worktreesDir);
