<!-- SPDX-License-Identifier: MIT -->

# AGENTS.md

## Non-discoverable command gotchas

- Use `pnpm` for installs and scripts when matching CI/release behavior; README examples may use `npm`, but release workflows pin pnpm 11 with Node 26.1.0.
- `pnpm run dependencies` is destructive: it removes and recreates `deps/`. Do not run it if the task needs to preserve local WADs, sound fonts, OpenTUI, or doomgeneric edits under `deps/`.

## Landmines

- Treat `deps/`, `dist/`, and `tmp/` as generated/local artifact areas unless the user explicitly asks to rebuild or inspect them.
