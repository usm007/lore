---
name: project-knowledge
description: Understand and maintain the project's architecture, modules, relationships, conventions, decisions, and development knowledge efficiently.
---

# Project Knowledge

Use the `.project/` knowledge layer so you don't re-explore the repo every session.
Knowledge files are an index, not the truth — **source code is always authoritative**.

## Workflow

1. **Start compact:** read `.project/overview.md` first (small context budget).
2. **Scope to subsystem:** find the relevant row in `.project/modules.md`, then read ONLY the
   detail files that matter (`architecture.md`, `data-flow.md`, `dependencies.md`,
   `conventions.md`, `decisions.md`, `known-issues.md`, `test-map.md`, `knowledge.json`).
3. **Inspect source only when necessary:** use file:line references from the knowledge files
   (e.g. `src/<area>/<Service>.ext`) instead of repo-wide searches.
4. **Prefer relationships over blind search:** map the entry chain for this repo
   (see `architecture.md`); follow module boundaries in `modules.md` — follow them.
5. **Respect quality labels:** FACT = backed by source; INFERENCE = strong structural conclusion;
   UNCERTAINTY = unverified. Never invent architecture, deps, or behavior. Verify cheap claims
   by reading the cited file before acting.
6. **Token discipline:** keep the overview in context; leave detail files on disk until needed;
   never paste large source passages into knowledge files.

## Maintaining the knowledge base

- After architecture or important behavior changes, update the affected `.project/*.md` rows and
  `knowledge.json` (bump `version`, fix module confidences) — targeted edits, never full rewrites.
- Staged refresh pipeline: mechanical facts → change detection → affected modules →
  targeted analysis → knowledge update. See `/project-knowledge-refresh`. Check staleness with
  `/project-knowledge-status`.
- Mechanical facts are automatic and deterministic — never hand-edit them, never re-derive them:
  `node <config>/project-knowledge/mechanical.js <repoRoot>` syncs manifest versions,
  test inventory, and modules.md reference health into owned marker blocks
  (`<!-- mechanical:start:<key> -->…<!-- mechanical:end:<key> -->`) plus machine fields
  in `knowledge.json`. Local triggers (git hooks + optional daily schedule):
  `node <config>/project-knowledge/install-hooks.js <repoRoot> [--schedule]`.
- Never document generated output (build dirs, caches, deps, user-data — see
  `knowledge.json` generated note, if present) as architecture.
