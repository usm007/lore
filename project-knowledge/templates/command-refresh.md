---
description: Incrementally refresh the .project/ knowledge base after repo changes (staged, no full regen).
---

# /project-knowledge-refresh

Staged incremental refresh. Do NOT re-scan the whole repo or rewrite all knowledge files.

1. Run mechanical sync first (deterministic, fully local, no LLM):
   `node <config>/project-knowledge/mechanical.js <repoRoot>`
   This patches manifest versions, test inventory, and modules.md reference health
   into owned marker blocks only — human prose is never touched.
2. Run change detection:
   `node <config>/project-knowledge/refresh.js <repoRoot> [--dry-run to preview]`
   This reports changed files and marks affected modules stale in
   `.project/state/stale.json`.
3. For each affected module ONLY: read the listed knowledge file(s), then diff/inspect the changed
   source files (targeted reads, not repo-wide search).
4. Apply targeted edits to the affected `.project/*.md` rows and `knowledge.json`
   (keep FACT/INFERENCE/UNCERTAINTY labels; keep file:line references accurate).
   If manifests, public APIs, or deps changed, also update `dependencies.md` /
   `data-flow.md` as appropriate — still scoped to the diff.
5. Clear resolved stale state: `node <config>/project-knowledge/refresh.js <repoRoot> --clear`
6. Report: files changed, modules touched, knowledge files updated, anything needing manual review.
   Local-only automation: git hooks (`post-commit`/`post-merge`/`post-checkout`, installed via
   `node <config>/project-knowledge/install-hooks.js <repoRoot> [--schedule[=full]]`) run steps 1–2
   automatically; `node <config>/project-knowledge/auto-sync.js <repoRoot>` runs the whole loop
   unattended (agent pass gated on stale + runner availability) — the agent handles semantic rows only.
