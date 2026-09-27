# /project-knowledge-init

Create project knowledge baseline. Safe by construction: skips existing docs
unless `--force`, never modifies source, never commits.

```bash
node project-knowledge/bootstrap.mjs <repoRoot>              # create .project/ + AGENTS.md (skips existing, installs local git hooks)
node project-knowledge/bootstrap.mjs <repoRoot> --dry-run    # preview planned actions, write nothing
node project-knowledge/bootstrap.mjs <repoRoot> --force      # overwrite docs (backs up to .project/.backup/<ts>/ first)
node project-knowledge/mechanical.js <repoRoot>              # deterministic facts after the agent fill pass
```

Flow: bootstrap → agent fills `(agent)` stubs by reading source
(`modules.md`, `architecture.md`, `data-flow.md`, `conventions.md`,
`decisions.md`, `known-issues.md`, `test-map.md` — keep
FACT / INFERENCE / UNCERTAINTY labels, file:line references) →
mechanical sync → `/project-knowledge-status` to verify.

Rules:

- If `.project/` already exists, prefer `/project-knowledge-refresh`
  (or `bootstrap.mjs --baseline-only` to repair `knowledge.json` only).
- Preserve unaffected documentation.
- `.project/state/stale.json` is ephemeral; do not require it committed.
