# /project-knowledge-status

Read-only report of project-knowledge health. Never modifies files.

Run (from the installed global location or this repo):

```bash
node project-knowledge/status.js <repoRoot>
```

Report includes:

- knowledge age + baseline status (commit, timestamp, file count)
- changed files (git status, or "git unavailable" fallback)
- affected modules
- stale sections (from `.project/state/stale.json`)
- low-confidence areas (`knowledge.json/lowConfidence`)
- missing knowledge (absent `.project/*.md`)
- detected project type

Malformed `knowledge.json` / `stale.json` is reported, not thrown: repair with
`node project-knowledge/bootstrap.mjs <repoRoot> --baseline-only`.
