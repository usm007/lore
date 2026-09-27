#!/usr/bin/env node
/**
 * opencode-project-knowledge — bootstrap.mjs
 * Safely creates .project/ knowledge baseline in any repository.
 *
 * Guarantees:
 *  - never overwrites existing user files unless --force
 *  - never modifies source code, never commits
 *  - respects .gitignore (knowledge references only non-ignored source)
 *  - excludes build output, caches, vendor, deps, binaries, secrets
 *  - generates AGENTS.md only when appropriate (missing) and never overwrites
 *
 * Usage:
 *   node bootstrap.mjs <repoRoot> [--force] [--baseline-only] [--dry-run] [--json] [--no-hooks] [--schedule[=full]]
 * --force overwrites docs but backs up existing content to .project/.backup/<ts>/ first.
 * --dry-run prints planned actions and writes nothing.
 * Hook automation (fully local: untracked .git/hooks only, never committed) is
 * installed by default when <repoRoot>/.git exists; pass --no-hooks to skip.
 * --schedule registers a daily 02:30 mechanical run (local scheduler);
 * --schedule=full adds a weekly Sunday auto-sync incl. the gated agent pass.
 * Exit codes: 0 ok, 1 bad usage, 2 repo not found.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { detect } = require('./detect.js');
const { writeFileAtomicSync, withLockSync, cleanStaleTmpSync } = require('./atomic.js');

const VERSION = readVersion();
function readVersion() {
  try {
    const candidates = [
      new URL('./VERSION', import.meta.url),
      new URL('../VERSION', import.meta.url),
      new URL('../../VERSION', import.meta.url),
    ];
    for (const u of candidates) {
      try { return fs.readFileSync(u, 'utf8').trim(); } catch {}
    }
  } catch {}
  return '0.0.0';
}

const EXCLUDE = new Set(['node_modules','.git','dist','build','out','target','vendor','bin','obj','__pycache__','.venv','venv','.tox','coverage','.next','.nuxt','.expo','Pods','.gradle','.idea','.vscode','.opencode']);
const SECRET_PATTERNS = [/\.pem$/i, /\.key$/i, /\.pfx$/i, /\.p12$/i, /\.npmrc$/i, /\.pypirc$/i, /(^|\/)\.env(\.|$)/, /password/i, /passwd/i, /secret/i, /credential/i, /token/i, /private/i];
const BINARY_EXT = new Set(['.png','.jpg','.jpeg','.gif','.ico','.pdf','.zip','.tar','.gz','.exe','.dll','.so','.dylib','.bin','.dat','.mp4','.mov','.woff','.woff2','.ttf','.eot']);

function loadGitignore(root) {
  const pats = [];
  for (const f of [path.join(root, '.gitignore'), path.join(root, '.git', 'info', 'exclude')]) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      for (let line of raw.split('\n')) {
        line = line.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        pats.push(line.replace(/\/$/, ''));
      }
    } catch {}
  }
  return pats;
}
function isIgnored(rel, pats) {
  const norm = rel.replace(/\\/g, '/');
  for (const p of pats) {
    const base = p.includes('/') ? p.split('/').pop() : p;
    if (norm === p || norm.startsWith(p + '/')) return true;
    if (!p.includes('/') && norm.split('/').includes(base.replace(/\*/g, ''))) {
      if (minimatch(base, norm.split('/').pop())) return true;
    }
    if (p.startsWith('*.') && norm.endsWith(p.slice(1))) return true;
  }
  const top = norm.split('/')[0];
  if (EXCLUDE.has(top)) return true;
  const ext = path.extname(norm).toLowerCase();
  if (BINARY_EXT.has(ext)) return true;
  if (SECRET_PATTERNS.some((re) => re.test(norm))) return true;
  return false;
}
function minimatch(pat, name) {
  const rx = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return rx.test(name);
}

function walk(root, pats, max = 600) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < max) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (isIgnored(rel, pats)) continue;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        stack.push(full);
      } else if (e.isFile()) {
        files.push(rel.replace(/\\/g, '/'));
      }
    }
  }
  return files;
}

function gitDirFor(root) {
  try {
    const { execSync } = require('child_process');
    const out = execSync('git rev-parse --git-dir', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) return path.isAbsolute(out) ? out : path.join(root, out);
  } catch { /* not a git repo or git unavailable */ }
  return path.join(root, '.git');
}

function gitHead(root) {
  try {
    const { execSync } = require('child_process');
    const out = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) return out.slice(0, 40);
  } catch { /* fall back to file read */ }
  try {
    const gitDir = gitDirFor(root);
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*(.+)$/);
    if (m) {
      try { return fs.readFileSync(path.join(gitDir, m[1].trim()), 'utf8').trim().slice(0, 40); }
      catch { return null; }
    }
    return head.slice(0, 40);
  } catch { return null; }
}

function topDirs(files, n = 12) {
  const counts = {};
  for (const f of files) {
    const d = f.includes('/') ? f.split('/')[0] : '(root)';
    counts[d] = (counts[d] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function langFromExt(files) {
  const c = {};
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ext) c[ext] = (c[ext] || 0) + 1;
  }
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 10);
}

const T = {
  'overview.md': (ctx) => `# ${ctx.name} — Overview\n\n> FACT: generated by opencode-project-knowledge v${ctx.toolVersion} on ${ctx.date} from repository structure${ctx.commit ? ` (git ${ctx.commit.slice(0, 8)})` : ''}.\n> Source code is authoritative; this file is an accelerator, not a substitute.\n\n- Project: ${ctx.name}\n- Type: ${ctx.primary}${ctx.mixed ? ` (mixed: ${ctx.languages.join(', ')})` : ''}\n- Frameworks: ${ctx.frameworks.join(', ') || 'none detected'}\n- Top directories: ${ctx.topDirs.map(([d, n]) => `${d} (${n} files)`).join(', ') || 'n/a'}\n- Entry points (INFERENCE — verify): ${ctx.entryPoints.join(', ') || 'unknown — inspect top dirs'}\n\n## Confidence\n\n- FACT: file/directory names and manifests listed in knowledge.json.\n- INFERENCE: architecture guess in architecture.md — verify against source before relying on it.\n- UNCERTAINTY: marked inline where the generator was unsure.\n`,
  'architecture.md': (ctx) => `# Architecture\n\n> INFERENCE unless a file reference proves otherwise.\n\n- Style (INFERENCE): ${ctx.archGuess}\n- Top areas:\n${ctx.topDirs.map(([d, n]) => `  - \`${d}/\` — ${n} visible files (see modules.md)`).join('\n') || '  - (empty repository)'}\n- Data flow: see data-flow.md.\n- Open questions (UNCERTAINTY): confirm entry point and runtime wiring in source.\n`,
  'modules.md': (ctx) => `# Module map\n\n> FACT: directories observed during bootstrap. Keep entries as pointers, not copies.\n\n| Area | Path | Notes |\n|------|------|-------|\n${ctx.topDirs.map(([d]) => `| ${d} | \`${d}/\` | (agent) describe purpose + key files after reading source |`).join('\n') || '| (root) | `./` | empty repository |'}\n\n## How to use this map\n\n- Pick the smallest relevant area for the task; read source files directly.\n- Update this table when directories are added/renamed.\n`,
  'data-flow.md': () => `# Data flow\n\n> (agent) stub — trace one real request/operation through source and replace this stub.\n\n- Entry: (agent) name the real entry file + symbol.\n- Flow: entry → service → storage.\n- State: (agent) where persistent state lives.\n`,
  'dependencies.md': (ctx) => `# Dependencies\n\n- Manifests found (FACT): ${ctx.manifests.join(', ') || 'none'}\n- Runtime guess (INFERENCE): ${ctx.frameworks.join(', ') || ctx.primary}\n- Commands (verify in manifests): ${ctx.commands.join(', ') || '(agent) fill from manifest scripts'}\n`,
  'conventions.md': () => `# Conventions\n\n> (agent) stub — confirm from config + linters.\n\n- Formatting/lint: (agent) name config files (e.g. .editorconfig, eslint, ruff, dotnet .editorconfig).\n- Naming: follow surrounding code; do not reformat unrelated files.\n- Commits: do not commit unless asked.\n`,
  'decisions.md': () => `# Decisions\n\n> (agent) stub — record only decisions confirmed in docs, ADRs, or maintainer input.\n\n- (none recorded yet — do not invent.)\n`,
  'known-issues.md': () => `# Known issues\n\n> (agent) stub — record only reproduced issues with file references.\n\n- (none recorded yet.)\n`,
  'test-map.md': (ctx) => '# Test map\n\n- Test files found (FACT): ' + (ctx.testFiles.length ? ctx.testFiles.slice(0, 15).join(', ') + (ctx.testFiles.length > 15 ? ' (+' + (ctx.testFiles.length - 15) + ' more)' : '') : 'none detected') + '\n- How to run (verify): (agent) fill from manifests/CI after reading them.\n',
};

function entryPoints(files) {
  const cands = ['src/index.ts','src/index.js','src/main.ts','src/main.js','src/App.tsx','src/App.jsx','src/main.py','app/main.py','main.py','app.py','manage.py','cmd/main.go','main.go','src/main.go','src/lib.rs','src/main.rs','lib/main.dart','Program.cs','src/Program.cs','artisan','public/index.php','index.php','pom.xml','build.gradle','go.mod','Cargo.toml','composer.json'];
  const set = new Set(files);
  return cands.filter((c) => set.has(c)).slice(0, 8);
}
function manifests(files) {
  return files.filter((f) => /^(package\.json|pyproject\.toml|requirements\.txt|go\.mod|Cargo\.toml|composer\.json|pom\.xml|build\.gradle|.*\.sln|.*\.csproj|Gemfile|pubspec\.yaml)$/.test(f.split('/').pop())).slice(0, 10);
}
function commandsFor(pkg) {
  if (!pkg || !pkg.scripts) return [];
  return Object.keys(pkg.scripts).slice(0, 8).map((k) => `npm run ${k}`);
}

export function bootstrap(root, opts = {}) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    const err = new Error(`Repository not found: ${abs}`);
    err.code = 'REPO_NOT_FOUND';
    throw err;
  }
  if (opts.dryRun) return bootstrapInner(abs, opts); // no writes -> no lock needed
  return withLockSync(path.join(abs, '.project', '.lock'), () => bootstrapInner(abs, opts), { timeoutMs: 120000, staleMs: 120000 });
}

function bootstrapInner(abs, opts = {}) {
  const force = Boolean(opts.force);
  const baselineOnly = Boolean(opts.baselineOnly);
  const dryRun = Boolean(opts.dryRun);
  const detection = detect(abs);
  const pats = loadGitignore(abs);
  const files = walk(abs, pats);
  const commit = gitHead(abs);
  const name = path.basename(abs);
  const date = new Date().toISOString();
  const top = topDirs(files);
  const eps = entryPoints(files);
  const mans = manifests(files);
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8')); } catch {}

  const archGuess =
    detection.frameworks.includes('electron') ? 'desktop app (Electron main + renderer)' :
    detection.frameworks.includes('vue') || detection.frameworks.includes('react') ? 'component-based SPA/frontend with build tooling' :
    detection.primary === 'python' ? 'script/service layout (verify entry point)' :
    detection.primary === 'go' ? 'cmd + packages layout (verify)' :
    detection.primary === 'rust' ? 'crate with src/ + Cargo manifest' :
    detection.primary === 'dotnet' || detection.primary === 'csharp' ? 'solution + projects layout' :
    detection.primary === 'unknown' ? 'unknown — generic directory structure (UNCERTAINTY)' :
    'layered modules around detected entry points (verify)';

  const ctx = {
    name, date, commit, toolVersion: VERSION,
    primary: detection.primary, languages: detection.languages, mixed: detection.mixed,
    frameworks: detection.frameworks, topDirs: top, entryPoints: eps,
    manifests: mans, commands: commandsFor(pkg), archGuess,
    testFiles: files.filter((f) => /(test|spec)/i.test(f)).slice(0, 50),
    extMix: langFromExt(files),
  };

  const dir = path.join(abs, '.project');
  const stateDir = path.join(dir, 'state');
  if (!dryRun) {
    fs.mkdirSync(stateDir, { recursive: true });
    cleanStaleTmpSync(dir);
    cleanStaleTmpSync(stateDir);
  }

  const created = [], skipped = [], overwritten = [], backedUp = [];
  let backupDir = null;
  const ensureBackupDir = () => {
    if (!backupDir) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupDir = path.join(dir, '.backup', stamp);
      if (!dryRun) fs.mkdirSync(backupDir, { recursive: true });
    }
    return backupDir;
  };
  const writeSafe = (rel, content) => {
    const p = path.join(dir, rel);
    if (fs.existsSync(p) && !force && !baselineOnly) { skipped.push(rel); return; }
    if (baselineOnly && fs.existsSync(p) && rel !== 'knowledge.json') { skipped.push(rel); return; }
    const existed = fs.existsSync(p);
    if (dryRun) {
      if (existed) overwritten.push(rel); else created.push(rel);
      return;
    }
    if (existed && force) {
      // --force overwrites user content: back it up first so nothing is lost.
      const bdir = ensureBackupDir();
      const dest = path.join(bdir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(p, dest);
      backedUp.push(rel);
    }
    writeFileAtomicSync(p, content);
    if (existed) overwritten.push(rel); else created.push(rel);
  };

  for (const [rel, fn] of Object.entries(T)) writeSafe(rel, fn(ctx));

  // knowledge.json (baseline metadata) — mergeable, never destructive without --force.
  // Unknown user-added keys in a previous knowledge.json are preserved.
  const kjPath = path.join(dir, 'knowledge.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(kjPath, 'utf8')); } catch {}
  const kj = Object.assign({}, (prev && typeof prev === 'object' ? prev : null), {
    project: name,
    version: (prev && prev.version) || '0.1.0',
    tool: 'opencode-project-knowledge',
    toolVersion: VERSION,
    generatedAt: date,
    baseline: { commit, timestamp: date, fileCount: files.length },
    detection: { primary: detection.primary, languages: detection.languages, mixed: detection.mixed, frameworks: detection.frameworks },
    architecture: archGuess,
    manifests: mans,
    entryPoints: eps,
    topDirs: top.map(([d, n]) => ({ dir: d, files: n })),
    lowConfidence: detection.primary === 'unknown' ? ['project-type'] : [],
    filesSample: files.slice(0, 60),
  });
  if (!fs.existsSync(kjPath) || force || baselineOnly || !prev) {
    const existed = fs.existsSync(kjPath);
    if (dryRun) {
      if (existed) overwritten.push('knowledge.json'); else created.push('knowledge.json');
    } else {
      if (existed && force) {
        const bdir = ensureBackupDir();
        fs.copyFileSync(kjPath, path.join(bdir, 'knowledge.json'));
        backedUp.push('knowledge.json');
      }
      writeFileAtomicSync(kjPath, JSON.stringify(kj, null, 2) + '\n');
      if (existed) overwritten.push('knowledge.json'); else created.push('knowledge.json');
    }
  } else skipped.push('knowledge.json');

  // ephemeral stale state — create only if missing
  const stalePath = path.join(stateDir, 'stale.json');
  if (!fs.existsSync(stalePath)) {
    if (dryRun) created.push('state/stale.json');
    else {
      writeFileAtomicSync(stalePath, JSON.stringify({ version: 1, updatedAt: date, stale: [] }, null, 2) + '\n');
      created.push('state/stale.json');
    }
  } else skipped.push('state/stale.json');

  // AGENTS.md at repo root — only when missing (never overwrite).
  // Matches project-knowledge/templates/AGENTS.md sections; FACT rows are
  // pre-filled from detection, (agent) rows need source verification.
  let agentsCreated = false;
  const agentsPath = path.join(abs, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    const oneLiner = `${ctx.primary}${ctx.mixed ? ` (mixed: ${ctx.languages.join(', ')})` : ''}${ctx.frameworks.length ? ` / ${ctx.frameworks.join(', ')}` : ''} — ${ctx.archGuess}`;
    const agentsBody =
      `# AGENTS.md — ${name}\n\n${oneLiner}\n\n` +
      `## Layout\n` +
      `${top.slice(0, 8).map(([d, n]) => `- \`${d}/\` — ${n} visible files`).join('\n') || '- (empty repository)'}\n` +
      `Entry points (INFERENCE — verify): ${eps.join(', ') || 'unknown — inspect top dirs'}\n\n` +
      `## Commands\n` +
      `${ctx.commands.length ? ctx.commands.map((c) => `- \`${c}\``).join('\n') : '- (agent) fill from manifests/CI after reading them'}\n` +
      `Manifests (FACT): ${mans.join(', ') || 'none'}\n\n` +
      `## Conventions\n` +
      `- (agent) 3-6 high-value conventions from config + linters; follow surrounding code.\n\n` +
      `## Danger / do not touch\n` +
      `- (agent) load-bearing areas, generated dirs, data that must not be wiped.\n` +
      `- Never commit unless asked. Respect .gitignore and never record secrets.\n\n` +
      `## Config requirements\n` +
      `- (agent) SDKs, runtimes, services, env.\n\n` +
      `---\n` +
      `*Project knowledge: \`.project/overview.md\` first, then \`.project/modules.md\`. Drafted by project-knowledge bootstrap v${VERSION}. Source code is authoritative; verify against source.*\n`;
    if (dryRun) created.push('AGENTS.md (root)');
    else {
      writeFileAtomicSync(agentsPath, agentsBody);
      agentsCreated = true;
    }
  }

  // Local-only automation triggers (untracked .git/hooks + optional schedule).
  // Never committed, never pushed, exit-0 quiet, skip when .project/ absent.
  let hooks = { installed: [], chained: [], skipped: null };
  let schedule = null;
  if (opts.noHooks) {
    hooks.skipped = '--no-hooks';
  } else if (dryRun) {
    hooks.skipped = null;
    created.push('.git/hooks/{post-commit,post-merge,post-checkout} (planned, local-only)');
    if (opts.schedule) created.push('daily 02:30 mechanical schedule (planned, local-only)');
  } else {
    try {
      const hk = require('./install-hooks.js');
      hooks = hk.installHooks(abs);
      if (opts.schedule) schedule = hk.installSchedule(abs, opts.schedule === 'full' ? 'full' : 'daily');
    } catch (e) {
      hooks = { installed: [], chained: [], skipped: String((e && e.message) || e) };
    }
  }

  return { root: abs, detection, created, skipped, overwritten, backedUp, backupDir, dryRun, agentsCreated, hooks, schedule, knowledgeJson: kj };
}

const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (isMain) {
  const root = process.argv[2];
  if (!root || root === '--help' || root === '-h') {
    console.log('Usage: node bootstrap.mjs <repoRoot> [--force] [--baseline-only] [--dry-run] [--json] [--no-hooks] [--schedule]');
    process.exit(root ? 0 : 1);
  }
  try {
    const schedFlag = process.argv.find((a) => a === '--schedule' || a.startsWith('--schedule=')) || null;
    const res = bootstrap(root, {
      force: process.argv.includes('--force'),
      baselineOnly: process.argv.includes('--baseline-only'),
      dryRun: process.argv.includes('--dry-run'),
      noHooks: process.argv.includes('--no-hooks'),
      schedule: schedFlag === '--schedule=full' ? 'full' : (schedFlag ? 'daily' : null),
    });
    if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: true, ...res, detection: res.detection }, null, 2));
    else {
      console.log(`${res.dryRun ? 'DRY RUN — no changes written. ' : ''}Bootstrapped ${res.root}`);
      console.log(` type: ${res.detection.primary}${res.detection.mixed ? ' (mixed)' : ''}`);
      console.log(` created: ${res.created.join(', ') || '(none)'}`);
      console.log(` skipped: ${res.skipped.join(', ') || '(none)'}`);
      if (res.overwritten.length) console.log(` overwritten: ${res.overwritten.join(', ')}`);
      if (res.backedUp.length) console.log(` backed up to ${res.backupDir}: ${res.backedUp.join(', ')}`);
      if (res.agentsCreated) console.log(' created: AGENTS.md (root, was missing)');
      if (res.hooks.skipped) console.log(` hooks: skipped (${res.hooks.skipped})`);
      else if (!res.dryRun) console.log(` hooks (local-only): installed ${res.hooks.installed.join(', ') || '(none new)'}${res.hooks.chained.length ? `; chained ${res.hooks.chained.join(', ')}` : ''}`);
      if (res.schedule) {
        const bits = [];
        if (res.schedule.mechanical) bits.push(`mechanical: ${res.schedule.mechanical}`);
        if (res.schedule.agent) bits.push(`agent: ${res.schedule.agent}`);
        console.log(` schedule: ${bits.length ? bits.join(' + ') : res.schedule.error}`);
      }
    }
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exit(e && e.code === 'REPO_NOT_FOUND' ? 2 : 1);
  }
}
