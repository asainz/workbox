import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../ui/errors";
import { runProvision } from "./runner";

const withRoots = async (
  fn: (roots: { sourceRoot: string; targetRoot: string }) => Promise<void>
) => {
  const root = await mkdtemp(join(tmpdir(), "workbox-provision-"));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    await fn({ sourceRoot, targetRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("provision runner", () => {
  it("reports when no provision actions are configured", async () => {
    await withRoots(async ({ sourceRoot, targetRoot }) => {
      const result = await runProvision(
        { copy: [], steps: [] },
        { sourceRoot, targetRoot, worktreeName: "box1", mode: "capture" }
      );

      expect(result).toEqual({
        status: "ok",
        message: "no provision actions configured.",
        copies: [],
        steps: [],
        exitCode: 0,
      });
    });
  });

  it("copies files, skips missing optional files, overwrites destinations, and runs steps", async () => {
    await withRoots(async ({ sourceRoot, targetRoot }) => {
      await writeFile(join(sourceRoot, ".env"), "TOKEN=source\n");
      await mkdir(join(targetRoot, "nested"), { recursive: true });
      await writeFile(join(targetRoot, "nested", ".env"), "TOKEN=old\n");

      const result = await runProvision(
        {
          copy: [
            { from: ".env", to: "nested/.env", required: false },
            { from: ".missing", to: ".missing", required: false },
          ],
          steps: [
            {
              name: "env",
              run: 'printf \'%s:%s:%s:%s\' "$WORKBOX_NAME" "$WORKBOX_SOURCE" "$WORKBOX_WORKTREE" "$CUSTOM"',
              env: { CUSTOM: "ok" },
            },
          ],
        },
        { sourceRoot, targetRoot, worktreeName: "box1", mode: "capture" }
      );

      expect(result.status).toBe("ok");
      expect(result.message).toBe("provision completed.");
      expect(result.copies.map((copy) => copy.status)).toEqual(["copied", "skipped"]);
      expect(result.copies[0]).toEqual(expect.objectContaining({ required: false }));
      expect(result.steps[0]).toEqual(
        expect.objectContaining({
          name: "env",
          exitCode: 0,
          stdout: `box1:${sourceRoot}:${targetRoot}:ok`,
          stderr: "",
        })
      );
      expect(await readFile(join(targetRoot, "nested", ".env"), "utf8")).toBe("TOKEN=source\n");
    });
  });

  it("creates destination parent directories", async () => {
    await withRoots(async ({ sourceRoot, targetRoot }) => {
      await writeFile(join(sourceRoot, ".env"), "TOKEN=source\n");

      const result = await runProvision(
        { copy: [{ from: ".env", to: "config/local/.env", required: false }], steps: [] },
        { sourceRoot, targetRoot, worktreeName: "box1", mode: "capture" }
      );

      expect(result.exitCode).toBe(0);
      expect(await readFile(join(targetRoot, "config", "local", ".env"), "utf8")).toBe(
        "TOKEN=source\n"
      );
    });
  });

  it("fails missing required files", async () => {
    await withRoots(async ({ sourceRoot, targetRoot }) => {
      const result = await runProvision(
        { copy: [{ from: ".env", to: ".env", required: true }], steps: [] },
        { sourceRoot, targetRoot, worktreeName: "box1", mode: "capture" }
      );

      expect(result.status).toBe("failed");
      expect(result.message).toContain("missing required source");
      expect(result.copies[0]).toEqual(expect.objectContaining({ status: "failed" }));
    });
  });

  it("fails source paths that cannot be statted", async () => {
    await withRoots(async ({ sourceRoot, targetRoot }) => {
      await writeFile(join(sourceRoot, "not-a-dir"), "file\n");

      const result = await runProvision(
        { copy: [{ from: "not-a-dir/.env", to: ".env", required: false }], steps: [] },
        { sourceRoot, targetRoot, worktreeName: "box1", mode: "capture" }
      );

      expect(result.status).toBe("failed");
      expect(result.message).toContain('provision copy "not-a-dir/.env" failed');
    });
  });

  it("rejects directory sources", async () => {
    await withRoots(async ({ sourceRoot, targetRoot }) => {
      await mkdir(join(sourceRoot, "config"), { recursive: true });

      const result = await runProvision(
        { copy: [{ from: "config", to: "config", required: false }], steps: [] },
        { sourceRoot, targetRoot, worktreeName: "box1", mode: "capture" }
      );

      expect(result.status).toBe("failed");
      expect(result.message).toContain("source is a directory");
    });
  });

  it("reports copy failures", async () => {
    await withRoots(async ({ sourceRoot, targetRoot }) => {
      await writeFile(join(sourceRoot, ".env"), "TOKEN=source\n");
      await mkdir(join(targetRoot, ".env"), { recursive: true });

      const result = await runProvision(
        { copy: [{ from: ".env", to: ".env", required: false }], steps: [] },
        { sourceRoot, targetRoot, worktreeName: "box1", mode: "capture" }
      );

      expect(result.status).toBe("failed");
      expect(result.message).toContain('provision copy ".env" failed');
    });
  });

  it("fails step errors", async () => {
    await withRoots(async ({ sourceRoot, targetRoot }) => {
      const result = await runProvision(
        { copy: [], steps: [{ name: "fail", run: "exit 7" }] },
        { sourceRoot, targetRoot, worktreeName: "box1", mode: "capture" }
      );

      expect(result.status).toBe("failed");
      expect(result.message).toBe('provision step "fail" failed (exit 7).');
      expect(result.exitCode).toBe(7);
    });
  });

  it("runs steps in inherited output mode", async () => {
    await withRoots(async ({ sourceRoot, targetRoot }) => {
      const result = await runProvision(
        { copy: [], steps: [{ name: "ok", run: "true" }] },
        { sourceRoot, targetRoot, worktreeName: "box1", mode: "inherit" }
      );

      expect(result.steps[0]).toEqual(
        expect.not.objectContaining({ stdout: expect.any(String), stderr: expect.any(String) })
      );
    });
  });

  it("rejects paths that escape their roots", async () => {
    await withRoots(async ({ sourceRoot, targetRoot }) => {
      await expect(
        runProvision(
          { copy: [{ from: "../.env", to: ".env", required: false }], steps: [] },
          { sourceRoot, targetRoot, worktreeName: "box1", mode: "capture" }
        )
      ).rejects.toBeInstanceOf(CliError);
    });
  });

  it("rejects symlinks that escape roots", async () => {
    await withRoots(async ({ sourceRoot, targetRoot }) => {
      const outside = await mkdtemp(join(tmpdir(), "workbox-provision-outside-"));
      try {
        await symlink(outside, join(sourceRoot, "outside"));
        await expect(
          runProvision(
            { copy: [{ from: "outside/.env", to: ".env", required: false }], steps: [] },
            { sourceRoot, targetRoot, worktreeName: "box1", mode: "capture" }
          )
        ).rejects.toThrow(/escapes repo root via symlink/);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
