'use strict';
/**
 * opencode-project-knowledge — mechanical.js
 * Deterministic, no-LLM facts-to-docs sync. Language-agnostic.
 *
 * Reads mechanical facts from source (manifest versions, test inventory,
 * line counts for paths referenced in modules.md, top-dir drift) and writes
 * them ONLY into owned regions:
 *   - .md files: blocks delimited by
 *       <!-- mechanical:start:<key> --> ... <!-- mechanical:end:<key> -->
 *     (inserted at EOF when absent; human prose outside markers is never touched)
 *   - knowledge.json: machine fields only (baseline, detection, versions,
 *     testInventory, refHealth, mechanical) — unknown user keys preserved.
 *
 * Never touches source code, never commits, never uses the network.
 * Local-only by design: all writes stay inside <root>/.project/.
 *
 * CLI:
 *   node mechanical.js <repoRoot> [--dry-run] [--json] [--quiet]
 * Exit codes: 0 ok, 1 bad usage, 2 repo not found.
 */

const fs = require('fs');
const path = require('path');

const EXCLUDE_DIRS = new Set([  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  'bin', 'obj', '__pycache__', '.venv', 'venv', '.tox', 'coverage',
  '.next', '.nuxt', '.expo', 'Pods', '.gradle', '.idea', '.vscode',
  '.project', '.opencode', '.agents', '.claude',
]);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.mp4', '.mov',
  '.woff', '.woff2', '.ttf', '.eot',
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WALK_FILES = 5000;

// BOM-tolerant read/parse (Windows editors — incl. PowerShell Set-Content —
// often write UTF-8 BOMs that JSON.parse rejects).
function stripBom(s) {
  return String(s || '').replace(/^﻿/, '');
}
function parseJsonSafe(raw) {
  try { return JSON.parse(stripBom(raw)); } catch { return null; }
}

// manifest file -> version extractor (rel path match, generic across ecosystems)
function extractVersions(root) {
  const out = [];
  const push = (file, version) => { if (version) out.push({ file, version: String(version).trim() }); };
  const read = (p) => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return null; } };

  // node
  const pkgRaw = read('package.json');
  if (pkgRaw) {
    const pkg = parseJsonSafe(pkgRaw);
    if (pkg) push('package.json', pkg.version);
  }
  // dotnet: top-level + one level deep *.csproj / *.fsproj / *.vbproj
  for (const proj of findProjects(root, ['.csproj', '.fsproj', '.vbproj'], 2)) {
    const raw = read(proj);
    if (raw) {
      const m = raw.match(/<Version>([^<]+)<\/Version>/);
      push(proj, m && m[1]);
    }
  }
  // python
  const pyproject = read('pyproject.toml');
  if (pyproject) {
    const m = pyproject.match(/^version\s*=\s*["']([^"']+)["']/m);
    push('pyproject.toml', m && m[1]);
  }
  // rust
  const cargo = read('Cargo.toml');
  if (cargo) {
    const m = cargo.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
    push('Cargo.toml', m && m[1]);
  }
  // php
  const composer = read('composer.json');
  if (composer) {
    const cj = parseJsonSafe(composer);
    if (cj) push('composer.json', cj.version);
  }
  // dart
  const pubspec = read('pubspec.yaml');
  if (pubspec) {
    const m = pubspec.match(/^version\s*:\s*([^\s#]+)/m);
    push('pubspec.yaml', m && m[1]);
  }
  // Inno Setup (windows installers, any ecosystem)
  for (const iss of findProjects(root, ['.iss'], 3)) {
    const raw = read(iss);
    if (raw) {
      const m = raw.match(/#define\s+MyAppVersion\s+"([^"]+)"/);
      push(iss, m && m[1]);
    }
  }
  return out;
}

function findProjects(root, exts, maxDepth) {
  const ignore = loadIgnoreLite(root);
  const found = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && found.length < 20) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (depth < maxDepth && !EXCLUDE_DIRS.has(e.name) && !e.name.startsWith('.') && !ignore.dir(rel)) {
          stack.push({ dir: full, depth: depth + 1 });
        }
      } else if (e.isFile() && exts.includes(path.extname(e.name).toLowerCase()) && !ignore.file(rel)) {
        found.push(rel);
      }
    }
  }
  return found.sort();
}

// ---- test inventory (generic file patterns + per-language method regexes) ----
const TEST_METHOD_RE = {
  '.cs': /^\s*\[\s*(Fact|Theory|TestMethod|Test|DataTestMethod)\b/,
  '.fs': /^\s*\[<Test>\]/,
  '.vb': /^\s*<\s*TestMethod\b/,
  '.py': /^\s*(async\s+)?def\s+test_\w*/,
  '.js': /^\s*(test|it)\s*\(/,
  '.jsx': /^\s*(test|it)\s*\(/,
  '.ts': /^\s*(test|it)\s*\(/,
  '.tsx': /^\s*(test|it)\s*\(/,
  '.mjs': /^\s*(test|it)\s*\(/,
  '.cjs': /^\s*(test|it)\s*\(/,
  '.vue': /^\s*(test|it)\s*\(/,
  '.go': /^func\s+Test\w*\s*\(/,
  '.rs': /^\s*#\[(test|tokio::test)/,
  '.java': /^\s*@Test\b/,
  '.kt': /^\s*@Test\b/,
  '.kts': /^\s*@Test\b/,
  '.rb': /^\s*(def\s+test_\w*|test\s+['"]|it\s+['"])/,
  '.php': /function\s+test\w*\s*\(/,
  '.dart': /^\s*(test|testWidgets)\s*\(/,
  '.swift': /^\s*func\s+test\w*\s*\(/,
};
function isTestFile(rel) {
  const norm = rel.replace(/\\/g, '/');
  const segs = norm.split('/');
  const base = segs.pop();
  // any directory segment denoting tests (exact or dotted suffix like MyApp.Tests)
  if (segs.some((s) => /(^|[._-])(test|tests|spec|specs|__tests__|e2e|testing)$/i.test(s))) return true;
  if (/(^|\/)(test|tests|spec|__tests__|e2e|testing)(\/|$)/.test(`${segs.join('/')}/`)) return true;
  if (/[._-](test|tests|spec)\.[a-z]+$/i.test(base)) return true;
  if (/(^test_.*|.*[._-]tests?\.[a-z]+$)/i.test(base) && !/^(latest|contest|protest)/i.test(base)) return true;
  if (/_test\.go$/.test(base) || /^test_.*\.py$/.test(base)) return true;
  return false;
}

// Lightweight .gitignore respect (basename/dir-prefix subset — enough to skip
// scratch, designer temp files, and local-only harnesses from the inventory).
function loadIgnoreLite(root) {
  const dirPrefixes = [];
  const baseExact = new Set();
  const suffixes = [];
  const relPaths = [];
  let raw = '';
  try { raw = fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch { /* none */ }
  for (let line of raw.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    if (line.endsWith('/')) { dirPrefixes.push(line.slice(0, -1)); continue; }
    if (line.startsWith('*.')) { suffixes.push(line.slice(1).toLowerCase()); continue; }
    if (line.includes('*') || line.includes('?')) {
      // segment glob like *_wpftmp.csproj or *_wpftmp.*
      const rx = new RegExp('^' + line.split('/').pop()
        .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      baseExact.add(`GLOB:${rx.source}`);
      continue;
    }
    if (line.includes('/')) relPaths.push(line.replace(/^\/+/, ''));
    else baseExact.add(line);
  }
  const globRes = [...baseExact].filter((s) => s.startsWith('GLOB:')).map((s) => new RegExp(s.slice(5), 'i'));
  const exacts = new Set([...baseExact].filter((s) => !s.startsWith('GLOB:')));
  return {
    dir(rel) {
      const norm = rel.replace(/\\/g, '/');
      const top = norm.split('/')[0];
      return dirPrefixes.some((d) => top === d || norm === d || norm.startsWith(`${d}/`));
    },
    file(rel) {
      const norm = rel.replace(/\\/g, '/');
      const base = norm.split('/').pop();
      if (relPaths.some((p) => norm === p || norm.startsWith(`${p}/`))) return true;
      if (exacts.has(base)) return true;
      if (suffixes.some((s) => base.toLowerCase().endsWith(s))) return true;
      return globRes.some((re) => re.test(base));
    },
  };
}

function walkSource(root, ignore) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < MAX_WALK_FILES) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        if (ignore && ignore.dir(rel)) continue;
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        stack.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (BINARY_EXT.has(ext)) continue;
        if (ignore && ignore.file(rel)) continue;
        let size = 0;
        try { size = fs.statSync(full).size; } catch { continue; }
        if (size > MAX_FILE_BYTES) continue;
        files.push(rel);
      }
    }
  }
  return files;
}

function testInventory(root, files) {
  const all = files || walkSource(root, loadIgnoreLite(root));
  const testFiles = all.filter(isTestFile);
  let methods = 0;
  const byLang = {};
  for (const rel of testFiles) {
    const ext = path.extname(rel).toLowerCase();
    const re = TEST_METHOD_RE[ext];
    if (!re) continue;
    let content;
    try { content = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    let n = 0;
    for (const line of content.split('\n')) {
      if (re.test(line)) n += 1;
    }
    methods += n;
    const lang = ext.slice(1);
    byLang[lang] = (byLang[lang] || 0) + n;
  }
  return { testFiles: testFiles.length, testMethodsApprox: methods, byLang, truncated: all.length >= MAX_WALK_FILES };
}

// Noise filters for `code` spans that look slashy but are not repo paths
// (symbol lists, env-var expressions, prose with ellipses, URLs).
function looksPathy(s) {
  if (/[=…]|(\.\.\.)|%|:\/\//.test(s)) return false;
  if (/[?#]/.test(s)) return false; // query/fragment — strip anchors before calling
  if (/\s/.test(s)) return false; // repo paths in docs don't contain spaces
  if (/^@/.test(s)) return false; // npm scopes / decorators, not paths
  if (!/[/\\.]/.test(s)) return false;
  // slash-separated symbol lists (Foo/Bar/Baz) have no dot, no backslash,
  // and no lowercase leading directory — treat as symbols, not paths.
  if (!/[.\\]/.test(s) && !/^[a-z0-9_]+[\\/]/i.test(s)) return false;
  return true;
}

function stripAnchor(s) {
  return s.replace(/[#?].*$/, '').replace(/[.,;:]+$/, '');
}

// Resolve a modules.md reference against real files:
// direct hit, "X.xaml(.cs)" expansion, suffix match (prefix-less refs like
// `Services/Foo.cs` matching `src/App/Services/Foo.cs`), or basename index.
function resolveRef(root, ref, files) {
  const norm = ref.replace(/\\/g, '/');
  const candidates = [norm];
  const paren = norm.match(/^(.+)(\(\.[a-z0-9]+\)+)$/i);
  if (paren) {
    const exts = paren[2].match(/\.[a-z0-9]+/gi) || [];
    for (const e of exts) candidates.push(paren[1] + e);
  }
  for (const c of candidates) {
    try {
      const s = fs.statSync(path.join(root, c));
      if (s.isFile() || s.isDirectory()) return c;
    } catch { /* next */ }
  }
  if (files) {
    // suffix match first (keeps directory context), then bare basename
    const suf = files.filter((f) => candidates.some((c) => f === c || f.endsWith(`/${c}`)));
    if (suf.length) return suf.sort((a, b) => a.length - b.length)[0];
    if (!norm.includes('/')) {
      const key = norm.toLowerCase();
      const base = files.filter((f) => f.split('/').pop().toLowerCase() === key);
      if (base.length) return base.sort((a, b) => a.length - b.length)[0];
    }
  }
  return null;
}
// Extensions worth reporting when a single-segment filename reference is stale.
// Anything else (`.bak`, `.localstate`, symbol suffixes like `App.StartMinimized`)
// is prose noise, not a broken pointer.
const KNOWN_FILE_EXTS = new Set([
  '.cs', '.fs', '.vb', '.xaml', '.axaml', '.py', '.pyi', '.js', '.jsx', '.ts',
  '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.go', '.rs', '.java', '.kt',
  '.kts', '.rb', '.php', '.c', '.h', '.hpp', '.cpp', '.cc', '.swift', '.dart',
  '.csproj', '.fsproj', '.vbproj', '.sln', '.props', '.targets', '.json',
  '.yaml', '.yml', '.toml', '.ini', '.xml', '.html', '.css', '.scss', '.sql',
  '.ps1', '.sh', '.bat', '.cmd', '.iss', '.manifest', '.gradle', '.md',
  '.dockerfile', '.editorconfig',
]);

function modulesRefs(root, files) {
  const mdPath = path.join(root, '.project', 'modules.md');
  let md;
  try { md = fs.readFileSync(mdPath, 'utf8'); } catch { return null; }
  // searchable files = walked source + .project docs (modules reference those too)
  let searchable = (files || []).slice();
  try {
    for (const e of fs.readdirSync(path.join(root, '.project'), { withFileTypes: true })) {
      if (e.isFile()) searchable.push(`.project/${e.name}`);
    }
  } catch { /* no .project dir listing */ }
  const spans = new Set();
  const re = /`([^`\n]+)`/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    let s = stripAnchor(m[1].trim());
    // strip brace/glob expansions and trailing slashes
    s = s.split(/[*{(|]/)[0].replace(/[\\/]+$/, '');
    if (!s || s.length < 2 || s.length > 200) continue;
    if (!looksPathy(s)) continue;
    spans.add(s);
  }
  const missing = [];
  const lineCounts = {};
  for (const ref of spans) {
    const hit = resolveRef(root, ref, searchable);
    if (hit) {
      try {
        const s2 = fs.statSync(path.join(root, hit));
        if (s2.isFile() && s2.size <= MAX_FILE_BYTES) {
          const content = fs.readFileSync(path.join(root, hit), 'utf8');
          lineCounts[hit] = content.split('\n').length;
        }
      } catch { /* ignore */ }
      continue;
    }
    // Unresolvable: report only genuine-looking file pointers.
    // - extension-only mentions (`.bak`), symbol suffixes (`App.StartMinimized`) → skip
    // - slash-separated symbol lists whose LAST segment has no extension → skip
    // - windows-style `A\b` env/concept paths without extension → skip
    if (/^\./.test(ref)) continue;
    const last = ref.replace(/\\/g, '/').split('/').pop();
    const ext = (last.match(/\.[a-z0-9]+$/i) || [])[0];
    if (!ext || !KNOWN_FILE_EXTS.has(ext.toLowerCase())) continue;
    missing.push(ref);
  }
  return { checked: spans.size, missing: missing.sort(), lineCounts };
}

function topLevelDirs(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !EXCLUDE_DIRS.has(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

function gitHead(root) {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*(.+)$/);
    if (m) {
      try { return fs.readFileSync(path.join(root, '.git', m[1].trim()), 'utf8').trim().slice(0, 40); }
      catch { return null; }
    }
    return head.slice(0, 40);
  } catch { return null; }
}

function readVersion() {
  try {
    const u = new URL('./VERSION', `file://${__dirname}/`.replace(/\\/g, '/'));
    return fs.readFileSync(u, 'utf8').trim();
  } catch { return '0.0.0'; }
}

// ---- owned-region writer ----
function upsertBlock(content, key, body) {
  const start = `<!-- mechanical:start:${key} -->`;
  const end = `<!-- mechanical:end:${key} -->`;
  const block = `${start}\n${body}\n${end}`;
  const re = new RegExp(`<!-- mechanical:start:${key} -->[\\s\\S]*?<!-- mechanical:end:${key} -->`);
  if (re.test(content)) return { content: content.replace(re, () => block), changed: true, mode: 'replaced' };
  const sep = content.endsWith('\n') ? '\n' : '\n\n';
  return { content: `${content}${sep}${block}\n`, changed: true, mode: 'appended' };
}

function mechanical(root, opts = {}) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    const e = new Error(`Repository not found: ${abs}`);
    e.code = 'REPO_NOT_FOUND';
    throw e;
  }
  // Pre-lock guard: taking the lock would mkdir .project/ as a side effect,
  // defeating the no-.project skip below. No lock needed for a pure skip.
  if (!fs.existsSync(path.join(abs, '.project'))) {
    return {
      root: abs, dryRun: Boolean(opts.dryRun), skipped: 'no .project/ (run bootstrap.mjs first)',
      versions: [], tests: null, refHealth: null, unmappedDirs: [], actions: ['skipped: .project/ absent'], changes: { docs: [], knowledgeJson: false },
    };
  }
  if (opts.dryRun) return mechanicalInner(abs, opts);
  const { withLockSync } = require('./atomic');
  return withLockSync(path.join(abs, '.project', '.lock'), () => mechanicalInner(abs, opts));
}

function mechanicalInner(abs, opts = {}) {
  const { writeFileAtomicSync, cleanStaleTmpSync } = require('./atomic');
  const { detect } = require('./detect');
  const toolVersion = readVersion();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const detection = detect(abs);
  const versions = extractVersions(abs);
  const ignore = loadIgnoreLite(abs);
  const sourceFiles = walkSource(abs, ignore);
  const tests = testInventory(abs, sourceFiles);
  const refs = modulesRefs(abs, sourceFiles);
  const dirs = topLevelDirs(abs);

  // top-dir drift vs modules.md mentions (excluding known generated dirs)
  let modulesText = null;
  try { modulesText = fs.readFileSync(path.join(abs, '.project', 'modules.md'), 'utf8'); } catch { /* none */ }
  let generated = [];
  try {
    const kjPre = parseJsonSafe(fs.readFileSync(path.join(abs, '.project', 'knowledge.json'), 'utf8'));
    if (kjPre && Array.isArray(kjPre.generatedDirs)) generated = kjPre.generatedDirs;
  } catch { /* none */ }
  const genTops = new Set(generated.map((g) => String(g).replace(/\\/g, '/').split('/')[0].replace(/\/$/, '')));
  const unmapped = modulesText
    ? dirs.filter((d) => !genTops.has(d) && !modulesText.includes(`\`${d}/\``) && !modulesText.includes(`\`${d}\``) && !modulesText.includes(d))
    : dirs.filter((d) => !genTops.has(d));

  const actions = [];
  const changes = { docs: [], knowledgeJson: false };

  const stamp = `_Deterministic sync by mechanical.js v${toolVersion} on ${today} — do not hand-edit inside markers._`;

  // 1. overview.md — versions block
  if (versions.length) {
    const body = ['| Manifest | Version |', '|---|---|']
      .concat(versions.map((v) => `| \`${v.file}\` | ${v.version} |`))
      .concat(['', stamp])
      .join('\n');
    actions.push(`overview.md/versions: ${versions.map((v) => `${v.file}@${v.version}`).join(', ')}`);
    if (!opts.dryRun) {
      const p = path.join(abs, '.project', 'overview.md');
      if (fs.existsSync(p)) {
        const r = upsertBlock(fs.readFileSync(p, 'utf8'), 'versions', body);
        writeFileAtomicSync(p, r.content);
        changes.docs.push(`overview.md (versions ${r.mode})`);
      }
    } else {
      changes.docs.push('overview.md (versions — would write)');
    }
  }

  // 2. test-map.md — inventory block
  {
    const lines = [
      `**FACT (mechanical ${today}):** ${tests.testFiles} test file(s), ~${tests.testMethodsApprox} test method(s) (regex count, approximations for BDD-style suites).`,
    ];
    const langs = Object.entries(tests.byLang).sort((a, b) => b[1] - a[1]);
    if (langs.length) lines.push(`By extension: ${langs.map(([l, n]) => `${l} ~${n}`).join(', ')}.`);
    lines.push('Run commands: see manifest scripts / CI config (agent: verify before quoting).');
    lines.push('', stamp);
    actions.push(`test-map.md/inventory: ${tests.testFiles} files, ~${tests.testMethodsApprox} methods`);
    if (!opts.dryRun) {
      const p = path.join(abs, '.project', 'test-map.md');
      if (fs.existsSync(p)) {
        const r = upsertBlock(fs.readFileSync(p, 'utf8'), 'test-inventory', lines.join('\n'));
        writeFileAtomicSync(p, r.content);
        changes.docs.push(`test-map.md (test-inventory ${r.mode})`);
      }
    } else {
      changes.docs.push('test-map.md (test-inventory — would write)');
    }
  }

  // 3. modules.md — reference health block
  if (refs) {
    const lines = [
      `**FACT (mechanical ${today}):** checked ${refs.checked} path reference(s) in this file.`,
    ];
    if (refs.missing.length) {
      lines.push(`Missing (${refs.missing.length}) — stale references needing agent review:`);
      for (const x of refs.missing.slice(0, 20)) lines.push(`- \`${x}\``);
      if (refs.missing.length > 20) lines.push(`- … (+${refs.missing.length - 20} more)`);
    } else {
      lines.push('All references resolve. (Directories count as resolved without line counts.)');
    }
    const counted = Object.entries(refs.lineCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
    if (counted.length) {
      lines.push('', 'Largest referenced files (lines):');
      for (const [f, n] of counted) lines.push(`- \`${f}\` — ${n} lines`);
    }
    if (unmapped.length) {
      lines.push('', `Top-level dirs not mentioned in modules.md: ${unmapped.map((d) => `\`${d}/\``).join(', ')} (agent: map or ignore).`);
    }
    lines.push('', stamp);
    actions.push(`modules.md/ref-health: ${refs.checked} refs, ${refs.missing.length} missing, ${unmapped.length} unmapped dirs`);
    if (!opts.dryRun) {
      const p = path.join(abs, '.project', 'modules.md');
      if (fs.existsSync(p)) {
        const r = upsertBlock(fs.readFileSync(p, 'utf8'), 'ref-health', lines.join('\n'));
        writeFileAtomicSync(p, r.content);
        changes.docs.push(`modules.md (ref-health ${r.mode})`);
      }
    } else {
      changes.docs.push('modules.md (ref-health — would write)');
    }
  }

  // 4. knowledge.json — machine fields only, unknown user keys preserved
  let kj = null;
  const kjPath = path.join(abs, '.project', 'knowledge.json');
  try { kj = parseJsonSafe(fs.readFileSync(kjPath, 'utf8')); } catch { kj = null; }
  if (!opts.dryRun) {
    cleanStaleTmpSync(path.join(abs, '.project'));
    const prev = (kj && typeof kj === 'object') ? kj : {};
    const next = Object.assign({}, prev, {
      baseline: { commit: gitHead(abs), timestamp: now, toolVersion },
      detection: { primary: detection.primary, languages: detection.languages, mixed: detection.mixed, frameworks: detection.frameworks },
      versions,
      testInventory: { date: today, testFiles: tests.testFiles, testMethodsApprox: tests.testMethodsApprox, byLang: tests.byLang },
      refHealth: refs ? { date: today, checked: refs.checked, missing: refs.missing } : { date: today, checked: 0, missing: [], note: 'modules.md absent' },
      unmappedDirs: unmapped,
      mechanical: { updatedAt: now, toolVersion },
    });
    if (!fs.existsSync(path.dirname(kjPath))) fs.mkdirSync(path.dirname(kjPath), { recursive: true });
    writeFileAtomicSync(kjPath, JSON.stringify(next, null, 2) + '\n');
    changes.knowledgeJson = true;
    actions.push('knowledge.json machine fields updated (user keys preserved)');
  } else {
    actions.push('knowledge.json machine fields — would write (dry run)');
  }

  return {
    root: abs, dryRun: Boolean(opts.dryRun), toolVersion,
    versions, tests, refHealth: refs ? { checked: refs.checked, missing: refs.missing } : null,
    unmappedDirs: unmapped, actions, changes,
  };
}

if (require.main === module) {
  const root = process.argv[2];
  const asJson = process.argv.includes('--json');
  const quiet = process.argv.includes('--quiet');
  if (!root || root === '--help' || root === '-h') {
    console.error('Usage: node mechanical.js <repoRoot> [--dry-run] [--json] [--quiet]');
    process.exit(1);
  }
  try {
    const res = mechanical(root, { dryRun: process.argv.includes('--dry-run') });
    if (asJson) {
      console.log(JSON.stringify({ ok: true, ...res }, null, 2));
    } else if (!quiet) {
      if (res.skipped) {
        console.log(`mechanical sync: ${res.root} — ${res.skipped}`);
      } else {
        console.log(`mechanical sync: ${res.root}${res.dryRun ? ' (DRY RUN — nothing written)' : ''}`);
        for (const a of res.actions) console.log(` - ${a}`);
        if (res.changes.docs.length) console.log(`docs: ${res.changes.docs.join('; ')}`);
        if (res.refHealth && res.refHealth.missing.length) {
          console.log(`stale refs (${res.refHealth.missing.length}): ${res.refHealth.missing.slice(0, 10).join(', ')}${res.refHealth.missing.length > 10 ? '…' : ''}`);
        }
        if (res.unmappedDirs.length) console.log(`unmapped dirs: ${res.unmappedDirs.join(', ')}`);
      }
    }
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exit(e && e.code === 'REPO_NOT_FOUND' ? 2 : 1);
  }
}

module.exports = { mechanical };
