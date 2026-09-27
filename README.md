# lore

An OpenCode plugin that keeps compact project knowledge for your repositories
and serves it back as context on demand.

## What it does

- Remembers each repo's structure, modules, decisions, and low-confidence areas.
- Hands the agent a short PROJECT CONTEXT brief before deep work, instead of
  re-exploring the codebase every time.
- Tracks what's changed since the brief was written and marks stale sections.

## Flow

1. `/project-knowledge-init` (`project_bootstrap` tool) — create `.project/`
   baseline when missing. Safe: skips existing docs unless `--force`
   (backs up to `.project/.backup/<ts>/`), never touches source, never commits.
2. Agent fills `(agent)` stubs by reading source — keep FACT / INFERENCE /
   UNCERTAINTY labels and file references.
3. `node project-knowledge/mechanical.js <repoRoot>` — deterministic facts
   (versions, test inventory, ref health) into owned marker blocks only.
4. `/project-knowledge-status` (`project_status` tool) — read-only health check.
5. `/project-knowledge-refresh` (`project_refresh` tool) — mark stale modules,
   update baseline metadata; agent updates docs scoped to the diff.

`.project/` layout: `overview.md`, `architecture.md`, `modules.md`,
`data-flow.md`, `dependencies.md`, `conventions.md`, `decisions.md`,
`known-issues.md`, `test-map.md`, `knowledge.json`, `state/stale.json`.
`templates/` holds reference skeletons only.

## Install

Prerequisite: Node 20+.

1. Register the package in your OpenCode config:
   `usm007/lore` (public GitHub, installs automatically on restart).
2. Copy `commands/*.md` into your OpenCode commands directory for the
   `/project-knowledge-init`, `/project-knowledge-status` and
   `/project-knowledge-refresh` commands.
   Engine dir = installed `project-knowledge/` (OpenCode config dir or package root).
3. Restart OpenCode.

Local automation (opt-in, machine-local only): git hooks + daily schedule via
`node <engine>/install-hooks.js <repoRoot> [--schedule[=full]]`.
Nothing is committed or pushed.

Repair: `node <engine>/bootstrap.mjs <repoRoot> --baseline-only`
fixes malformed `knowledge.json` without touching docs.

## Tools

- `project_context` — compact PROJECT CONTEXT for a repository.
- `project_bootstrap` — create `.project/` knowledge baseline (safe, skips existing).
- `project_status` — read-only health report.
- `project_refresh` — mark stale + update baseline (`dryRun` to preview).

## Tests

`npm test` (`node --test tests/`).

The plugin degrades gracefully: if the engine or the tool helper is missing,
it loads hooks-only (or empty) instead of breaking the session.
