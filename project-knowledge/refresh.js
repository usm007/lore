'use strict';
/**
 * refresh.js — staged incremental refresh.
 * file change -> affected modules -> mark stale -> targeted baseline update.
 *
 * CLI:
 *   node refresh.js <repoRoot> [--json] [--mark-only] [--clear] [--dry-run]
 *   node refresh.js <repoRoot> --files "src/a.ts,src/b.ts"
 * --dry-run computes affected modules but writes nothing.
 * Exit codes: 0 ok, 1 bad usage, 2 repo not found.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { detect } = require('./detect');

const MEANINGFUL = [
  /\bpackage\.json$/, /\bpyproject\.toml$/, /\brequirements\.txt$/, /\bgo\.mod$/, /\bCargo\.toml$/,
  /\bcomposer\.json$/, /\bpom\.xml$/, /\bbuild\.gradle(\.kts)?$/, /\.sln$/, /\.csproj$/,
  /\btsconfig\.json$/, /\bvite\.config\./, /\bDockerfile$/,
];

function unquote(p) {
  p = String(p).trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return p;
}

/**
 * Parse `git status --porcelain=v1` lines into { tracked, untracked } path lists.
 * Renames (`R  old -> new`) yield both sides; quoted paths are unquoted.
 * Exported for testing.
 */
function parsePorcelain(output) {
  const tracked = [], untracked = [];
  for (const line of String(output || '').split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    let rest = line.slice(3);
    if (code.includes('R') && rest.includes(' -> ')) {
      const [oldP, newP] = rest.split(' -> ');
      tracked.push(unquote(oldP), unquote(newP));
    } else if (code.trim() === '??') {
      untracked.push(unquote(rest));
    } else {
      tracked.push(unquote(rest));
    }
  }
  return { tracked, untracked };
}

function gitPorcelain(root) {
  try {
    return execSync('git status --porcelain', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; } // git unavailable -> null (graceful)
}

/** Filter untracked paths through `git check-ignore`: ignored files are noise. */
function filterIgnored(root, paths) {
  if (!paths.length) return [];
  try {
    const out = execSync('git check-ignore --stdin', {
      cwd: root, input: paths.join('\n'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
    });
    const ignored = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
    return paths.filter((p) => !ignored.has(p));
  } catch {
    // check-ignore exits 1 when nothing matches (or git is broken) -> keep all.
    return paths;
  }
}

function gitChangedFiles(root) {
  const out = gitPorcelain(root);
  if (out === null) return [];
  const { tracked, untracked } = parsePorcelain(out);
  return tracked.concat(filterIgnored(root, untracked));
}

function moduleOf(f) {
  const norm = String(f).replace(/\\/g, '/');
  if (!norm.includes('/')) return '(root)';
  return norm.split('/')[0];
}

function classify(files) {
  const meaningful = [];
  const skipped = [];
  for (const f of files) {
    if (/(^|\/)(dist|build|out|target|node_modules|vendor|bin|obj|coverage|__pycache__|\.git)(\/|$)/.test(f)) { skipped.push(f); continue; }
    if (/\.(png|jpg|jpeg|gif|ico|pdf|zip|exe|dll|so|woff2?|ttf)$/i.test(f)) { skipped.push(f); continue; }
    meaningful.push(f);
  }
  return { meaningful, skipped };
}

function loadStale(root) {
  const p = path.join(root, '.project', 'state', 'stale.json');
  try { return { data: JSON.parse(fs.readFileSync(p, 'utf8')), path: p }; }
  catch { return { data: { version: 1, updatedAt: new Date().toISOString(), stale: [] }, path: p }; }
}

function refresh(root, opts = {}) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) {
    const e = new Error(`Repository not found: ${abs}`);
    e.code = 'REPO_NOT_FOUND';
    throw e;
  }
  if (opts.dryRun) return refreshInner(abs, opts); // no writes -> no lock needed
  const { withLockSync } = require('./atomic');
  return withLockSync(path.join(abs, '.project', '.lock'), () => refreshInner(abs, opts));
}

function refreshInner(abs, opts = {}) {
  const { writeFileAtomicSync, cleanStaleTmpSync } = require('./atomic');
  if (!opts.dryRun) {
    cleanStaleTmpSync(path.join(abs, '.project'));
    cleanStaleTmpSync(path.join(abs, '.project', 'state'));
  }
  const detection = detect(abs);
  let files = opts.files || gitChangedFiles(abs);
  const { meaningful, skipped } = classify(files);
  const modules = [...new Set(meaningful.map(moduleOf))];

  const kjPath = path.join(abs, '.project', 'knowledge.json');
  let kj = null;
  try { kj = JSON.parse(fs.readFileSync(kjPath, 'utf8')); } catch { kj = null; }

  const { data: stale, path: stalePath } = loadStale(abs);
  if (!Array.isArray(stale.stale)) stale.stale = [];

  const configTouched = meaningful.some((f) => MEANINGFUL.some((re) => re.test(f)));
  const structural = meaningful.some((f) => {
    // new/deleted files are structural; git porcelain already encodes renames as "R  old -> new"
    return true;
  });

  const actions = [];
  if (opts.clear) {
    stale.stale = [];
    actions.push('cleared stale state');
  } else if (meaningful.length) {
    for (const m of modules) {
      const entry = `${m}/ — changed: ${meaningful.filter((f) => moduleOf(f) === m).slice(0, 4).join(', ')}${meaningful.filter((f) => moduleOf(f) === m).length > 4 ? '…' : ''}`;
      if (!stale.stale.some((s) => s.startsWith(`${m}/`))) { stale.stale.push(entry); actions.push(`marked stale: ${m}/`); }
    }
    if (configTouched && !stale.stale.some((s) => s.startsWith('dependencies/'))) {
      stale.stale.push('dependencies/ — manifest/config changed');
      actions.push('marked stale: dependencies/');
    }
    if (opts.markOnly) {
      // stop before baseline update
    } else if (kj) {
      if (opts.dryRun) {
        actions.push('would update knowledge.json baseline metadata (dry run — not written)');
      } else {
        kj.generatedAt = kj.generatedAt || new Date().toISOString();
        kj.baseline = Object.assign({}, kj.baseline, { lastRefresh: new Date().toISOString(), pendingModules: modules });
        kj.detection = { primary: detection.primary, languages: detection.languages, mixed: detection.mixed, frameworks: detection.frameworks };
        writeFileAtomicSync(kjPath, JSON.stringify(kj, null, 2) + '\n');
        actions.push('updated knowledge.json baseline metadata (docs left for targeted agent update)');
      }
    } else {
      actions.push('no knowledge.json — run bootstrap.mjs to create baseline');
    }
  } else {
    actions.push(skipped.length && !files.length ? 'only ignored files changed — nothing to do' : 'clean — no changes detected');
  }

  stale.updatedAt = new Date().toISOString();
  if (!opts.dryRun) {
    writeFileAtomicSync(stalePath, JSON.stringify(stale, null, 2) + '\n');
  }

  return { root: abs, files: meaningful, skipped, modules, structural, configTouched, stale: stale.stale, actions, dryRun: Boolean(opts.dryRun) };
}

if (require.main === module) {
  const root = process.argv[2];
  if (!root) { console.error('Usage: node refresh.js <repoRoot> [--json] [--mark-only] [--clear] [--dry-run] [--files "a,b"]'); process.exit(1); }
  try {
    const fi = process.argv.findIndex((a) => a === '--files');
    const files = fi >= 0 ? String(process.argv[fi + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const res = refresh(root, { markOnly: process.argv.includes('--mark-only'), clear: process.argv.includes('--clear'), dryRun: process.argv.includes('--dry-run'), files });
    if (process.argv.includes('--json')) console.log(JSON.stringify(res, null, 2));
    else {
      if (res.dryRun) console.log('DRY RUN — no changes written.');
      console.log(`refresh: ${res.root}`);
      for (const a of res.actions) console.log(` - ${a}`);
      if (res.stale.length) console.log(`stale now: ${res.stale.join(' | ')}`);
      else console.log('stale: none');
    }
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exit(e && e.code === 'REPO_NOT_FOUND' ? 2 : 1);
  }
}

module.exports = { refresh, parsePorcelain, classify };
