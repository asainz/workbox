# workbox (wkb) [![CI](https://github.com/AlecRust/workbox/actions/workflows/ci.yml/badge.svg)](https://github.com/AlecRust/workbox/actions/workflows/ci.yml)

Minimal Bun-first CLI for Git worktrees. Creates a worktree per sandbox and removes it cleanly.

## Install

```sh
bun add -g @alecrust/workbox
```

Or via npm (still requires Bun on your PATH):

```sh
npm i -g @alecrust/workbox
```

Or install from GitHub:

```sh
bun add -g github:AlecRust/workbox
```

## Use

```sh
wkb new <name> [--from <ref>]         # create sandbox worktree
wkb rm <name> [--force] [--unmanaged] [--delete-branch] # remove worktree
wkb list                              # list workbox worktrees
wkb prune                             # prune stale git worktree metadata
wkb status [name]                     # show repo/worktree info and cleanliness
wkb setup                             # run configured bootstrap steps (in current worktree)
wkb dev <name>                        # run configured dev command in a sandbox
wkb exec <name> -- <cmd...>           # run a command in a sandbox
```

`workbox` and `wkb` are equivalent.

## Config

Looks for global config in:

1. `$XDG_CONFIG_HOME/workbox/config.toml`
2. `~/.workbox/config.toml` when `$XDG_CONFIG_HOME` is not set

Then looks for project config in:

1. `.workbox/config.toml`
2. `workbox.toml`

Config is required from at least one global or project location. Global config provides defaults;
project config overrides only the settings it defines. Paths are resolved relative to the repo root.
`worktrees.directory` must resolve within the repo root.

Example:

```toml
[worktrees]
directory = ".workbox/worktrees"
branch_prefix = "wkb/"
base_ref = "main"

[bootstrap]
enabled = true
steps = [
  { name = "install", run = "bun install" },
  { name = "build", run = "bun run build" }
]

[dev]
command = "bun run dev"
# Optional (explicit opt-in): open an editor when running `wkb dev`.
# open = "code ."
```

## Development

```sh
bun install
bun test
bun run check
bun run format
```

## Commit conventions

Conventional Commits are enforced. See `cog.toml`.
