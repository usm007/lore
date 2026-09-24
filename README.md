# lore

An OpenCode plugin that keeps compact project knowledge for your repositories
and serves it back as context on demand.

## What it does

- Remembers each repo's structure, modules, decisions, and low-confidence areas.
- Hands the agent a short PROJECT CONTEXT brief before deep work, instead of
  re-exploring the codebase every time.
- Tracks what's changed since the brief was written and marks stale sections.

## Install

1. Register the package in your OpenCode config:
   `usm007/lore` (public GitHub, installs automatically on restart).
2. Copy `commands/*.md` into your OpenCode commands directory for the
   `/project-knowledge-status` and `/project-knowledge-refresh` commands.
3. Restart OpenCode.

## Tools

- `project_context` — compact PROJECT CONTEXT for a repository.

## Tests

The plugin degrades gracefully: if the engine or the tool helper is missing,
it loads hooks-only (or empty) instead of breaking the session.
