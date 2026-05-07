import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export const isSubpath = (candidatePath: string, basePath: string): boolean => {
  const base = resolve(basePath);
  const candidate = resolve(candidatePath);
  if (candidate === base) {
    return true;
  }
  const baseWithSep = base.endsWith(sep) ? base : `${base}${sep}`;
  return candidate.startsWith(baseWithSep);
};

const realpathOrResolve = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
};

const checkSegmentsWithinRoot = async (
  rootResolved: string,
  rootReal: string,
  rel: string,
  label: string
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  let cursor = rootResolved;
  const segments = rel.split(sep).filter((segment) => segment.length > 0);

  for (const segment of segments) {
    cursor = join(cursor, segment);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) {
        const linkTarget = await realpathOrResolve(cursor);
        if (!isSubpath(linkTarget, rootReal)) {
          return {
            ok: false,
            reason: `${label} escapes repo root via symlink (${cursor} -> ${linkTarget}).`,
          };
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        return { ok: true };
      throw error;
    }
  }

  return { ok: true };
};

export const checkPathWithinRoot = async (input: {
  rootDir: string;
  candidatePath: string;
  label: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const rootResolved = resolve(input.rootDir);
  const rootReal = await realpathOrResolve(rootResolved);
  const candidateResolved = resolve(input.candidatePath);

  if (!isSubpath(candidateResolved, rootResolved)) {
    return {
      ok: false,
      reason: `${input.label} must be within repo root (${rootResolved}): ${input.candidatePath}`,
    };
  }

  const rel = relative(rootResolved, candidateResolved);
  if (!rel || rel === ".") {
    return { ok: true };
  }

  const segmentCheck = await checkSegmentsWithinRoot(rootResolved, rootReal, rel, input.label);
  if (!segmentCheck.ok) {
    return segmentCheck;
  }

  try {
    const candidateReal = await realpath(candidateResolved);
    if (!isSubpath(candidateReal, rootReal)) {
      return {
        ok: false,
        reason: `${input.label} must resolve within repo root (${rootReal}): ${input.candidatePath}`,
      };
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return { ok: true };
    throw error;
  }

  return { ok: true };
};
