# /project-knowledge-refresh

Incremental refresh of project knowledge. Updates only what changed.

```bash
node project-knowledge/mechanical.js <repoRoot>           # deterministic facts first (versions, tests, ref health)
node project-knowledge/refresh.js <repoRoot>              # mark stale + update baseline metadata
node project-knowledge/refresh.js <repoRoot> --mark-only  # only mark stale
node project-knowledge/refresh.js <repoRoot> --clear      # clear resolved stale state
node project-knowledge/refresh.js <repoRoot> --dry-run    # preview affected modules, write nothing
```

Flow: mechanical facts → file change → affected module detection → mark stale in
`.project/state/stale.json` → targeted doc updates (by agent, reading source)
→ baseline metadata update in `knowledge.json` → clear resolved stale state.

Local-only full automation (no network, no commits — hooks live in
untracked `.git/hooks`, schedule on the local machine):

```bash
node project-knowledge/install-hooks.js <repoRoot>              # git hooks: mechanical + mark-stale on commit/merge
node project-knowledge/install-hooks.js <repoRoot> --schedule   # plus daily 02:30 mechanical run
node project-knowledge/install-hooks.js <repoRoot> --schedule=full  # plus weekly auto-sync (gated agent pass)
node project-knowledge/install-hooks.js <repoRoot> --uninstall  # remove (restores chained hooks)
node project-knowledge/auto-sync.js <repoRoot> --dry-run        # preview the full unattended loop
node project-knowledge/auto-sync.js <repoRoot>                # full loop now (deterministic + gated agent pass)
```

Rules:

- Preserve unaffected documentation.
- Never silently regenerate the whole knowledge base (full `--force`
  bootstrap only when explicitly invoked).
- `.project/state/stale.json` is ephemeral; do not require it committed.
