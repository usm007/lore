'use strict';
/**
 * opencode-project-knowledge — detect.js
 * Language/framework-agnostic project detection.
 * No dependencies beyond Node.js built-ins.
 *
 * CLI:
 *   node detect.js <repoRoot> [--json]
 * Exit codes: 0 ok, 1 bad usage, 2 repo not found.
 */

const fs = require('fs');
const path = require('path');

const MARKERS = [
  // file marker -> { type, framework, weight }
  { file: 'package.json', type: 'node', weight: 3 },
  { file: 'pnpm-workspace.yaml', type: 'node', weight: 3 },
  { file: 'yarn.lock', type: 'node', weight: 2 },
  { file: 'package-lock.json', type: 'node', weight: 2 },
  { file: 'tsconfig.json', type: 'typescript', weight: 4 },
  { file: 'vue.config.js', type: 'vue', weight: 5 },
  { file: 'nuxt.config.js', type: 'vue', weight: 5 },
  { file: 'nuxt.config.ts', type: 'vue', weight: 5 },
  { file: 'vite.config.ts', type: 'node', weight: 1 },
  { file: 'vite.config.js', type: 'node', weight: 1 },
  { file: 'next.config.js', type: 'react', weight: 4 },
  { file: 'next.config.mjs', type: 'react', weight: 4 },
  { file: 'react-app-env.d.ts', type: 'react', weight: 3 },
  { file: 'angular.json', type: 'angular', weight: 5 },
  { file: 'electron-builder.yml', type: 'electron', weight: 5 },
  { file: 'electron-builder.json', type: 'electron', weight: 5 },
  { file: 'requirements.txt', type: 'python', weight: 4 },
  { file: 'setup.py', type: 'python', weight: 5 },
  { file: 'setup.cfg', type: 'python', weight: 4 },
  { file: 'pyproject.toml', type: 'python', weight: 5 },
  { file: 'Pipfile', type: 'python', weight: 4 },
  { file: 'poetry.lock', type: 'python', weight: 3 },
  { file: 'manage.py', type: 'python', weight: 3 },
  { file: 'app.py', type: 'python', weight: 1 },
  { file: 'main.py', type: 'python', weight: 1 },
  { file: 'pom.xml', type: 'java', weight: 5 },
  { file: 'build.gradle', type: 'java', weight: 5 },
  { file: 'build.gradle.kts', type: 'java', weight: 5 },
  { file: 'settings.gradle', type: 'java', weight: 3 },
  { file: 'src/main/java', type: 'java', weight: 3, dir: true },
  { file: 'AndroidManifest.xml', type: 'android', weight: 5 },
  { file: 'build.gradle', type: 'android', weight: 2 },
  { file: 'go.mod', type: 'go', weight: 5 },
  { file: 'go.sum', type: 'go', weight: 3 },
  { file: 'Cargo.toml', type: 'rust', weight: 5 },
  { file: 'Cargo.lock', type: 'rust', weight: 3 },
  { file: 'composer.json', type: 'php', weight: 5 },
  { file: 'artisan', type: 'php', weight: 3 },
  { file: 'CMakeLists.txt', type: 'cpp', weight: 4 },
  { file: 'Makefile', type: 'c', weight: 2 },
  { file: 'configure.ac', type: 'c', weight: 3 },
  { file: '.csproj', type: 'csharp', weight: 0, suffix: true },
  { file: '.sln', type: 'dotnet', weight: 5, suffix: true },
  { file: 'global.json', type: 'dotnet', weight: 4 },
  { file: 'Directory.Build.props', type: 'dotnet', weight: 3 },
  { file: 'Gemfile', type: 'ruby', weight: 5 },
  { file: 'Rakefile', type: 'ruby', weight: 3 },
  { file: 'pubspec.yaml', type: 'dart', weight: 5 },
  { file: 'Package.swift', type: 'swift', weight: 5 },
  { file: 'Dockerfile', type: 'docker', weight: 1 },
  { file: 'docker-compose.yml', type: 'docker', weight: 1 },
  { file: '.git', type: 'git', weight: 0, dir: true },
];

const EXT_MAP = {
  '.py': 'python',
  '.js': 'javascript',
  '.jsx': 'react',
  '.ts': 'typescript',
  '.tsx': 'react',
  '.vue': 'vue',
  '.cs': 'csharp',
  '.java': 'java',
  '.kt': 'android',
  '.kts': 'android',
  '.go': 'go',
  '.rs': 'rust',
  '.php': 'php',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.dart': 'dart',
  '.xml': null, // ambiguous
};

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  'bin', 'obj', '__pycache__', '.venv', 'venv', '.tox', 'coverage',
  '.next', '.nuxt', '.expo', 'Pods', '.gradle', '.idea', '.vscode',
]);

function exists(root, rel, isDir) {
  try {
    const p = path.join(root, rel);
    const st = fs.statSync(p);
    return isDir ? st.isDirectory() : st.isFile() || st.isDirectory();
  } catch { return false; }
}

function listTopLevel(root) {
  try { return fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
}

function suffixMatch(entries, suffix) {
  return entries.some((e) => e.isFile() && e.name.endsWith(suffix));
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

function detectFrameworks(root, pkg) {
  const fw = new Set();
  if (!pkg) return [];
  const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  const names = Object.keys(deps);
  if (names.includes('vue') || names.includes('nuxt')) fw.add('vue');
  if (names.includes('react') || names.includes('react-dom') || names.includes('next')) fw.add('react');
  if (names.includes('next')) fw.add('nextjs');
  if (names.includes('@angular/core')) fw.add('angular');
  if (names.includes('electron')) fw.add('electron');
  if (names.includes('express') || names.includes('fastify') || names.includes('koa')) fw.add('node-backend');
  if (pkg.main && /electron/i.test(String(pkg.main))) fw.add('electron');
  return [...fw];
}

function scanExtensions(root, maxFiles = 400) {
  const counts = {};
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < maxFiles * 4) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (seen > maxFiles * 4) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        stack.push(full);
      } else if (e.isFile()) {
        seen += 1;
        if (seen > maxFiles) continue;
        const ext = path.extname(e.name).toLowerCase();
        const lang = EXT_MAP[ext];
        if (lang) counts[lang] = (counts[lang] || 0) + 1;
        else if (ext) counts[`ext:${ext}`] = (counts[`ext:${ext}`] || 0) + 1;
      }
    }
  }
  return counts;
}

function detect(root) {
  const abs = path.resolve(root);
  const entries = listTopLevel(abs);
  const entryNames = new Set(entries.map((e) => e.name));
  const scores = {};
  const evidence = [];
  const add = (type, w, why) => {
    scores[type] = (scores[type] || 0) + w;
    if (why) evidence.push(`${type}: ${why}`);
  };

  for (const m of MARKERS) {
    if (m.suffix) {
      if (suffixMatch(entries, m.file)) add(m.type, m.file === '.sln' ? 5 : 4, `*${m.file} present`);
    } else if (exists(abs, m.file, m.dir)) {
      if (m.weight > 0) add(m.type, m.weight, `${m.file} present`);
    }
  }
  // .csproj scan one level deep (src/*/*.csproj common in dotnet)
  if (!scores.csharp && !scores.dotnet) {
    for (const e of entries) {
      if (e.isDirectory() && !EXCLUDE_DIRS.has(e.name)) {
        try {
          const sub = fs.readdirSync(path.join(abs, e.name));
          if (sub.some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) {
            add('dotnet', 4, `${e.name}/*.csproj|*.sln present`);
            break;
          }
        } catch { /* ignore */ }
      }
    }
  }

  let pkg = null;
  if (entryNames.has('package.json')) {
    pkg = readJsonSafe(path.join(abs, 'package.json'));
    if (pkg) {
      const frameworks = detectFrameworks(abs, pkg);
      for (const f of frameworks) {
        if (f === 'vue') add('vue', 4, 'package.json depends on vue/nuxt');
        else if (f === 'react') add('react', 4, 'package.json depends on react');
        else if (f === 'nextjs') add('react', 2, 'package.json depends on next');
        else if (f === 'angular') add('angular', 4, 'package.json depends on @angular/core');
        else if (f === 'electron') add('electron', 5, 'package.json depends on electron');
      }
      if (pkg.scripts && pkg.scripts.dev && /electron/i.test(JSON.stringify(pkg))) {
        add('electron', 2, 'package.json references electron');
      }
    }
  }

  const extCounts = scanExtensions(abs);
  const langTotals = {};
  for (const [k, v] of Object.entries(extCounts)) {
    if (!k.startsWith('ext:')) langTotals[k] = v;
  }
  // Extension evidence (lower weight than manifests)
  const extWeight = { python: 1, javascript: 1, typescript: 1, react: 1, vue: 2, csharp: 1, java: 1, go: 1, rust: 1, php: 1, c: 1, cpp: 1, android: 1 };
  for (const [lang, n] of Object.entries(langTotals)) {
    if (n >= 2) add(lang, Math.min(3, (extWeight[lang] || 1) + (n >= 10 ? 1 : 0)), `${n} *.${lang} source files`);
    else if (n === 1 && !Object.keys(scores).length) add(lang, 1, `single ${lang} source file`);
  }

  // Normalise: electron implies node; vue/react imply js/ts base
  const types = Object.entries(scores)
    .filter(([t]) => t !== 'git' && t !== 'docker')
    .sort((a, b) => b[1] - a[1]);

  let primary = 'unknown';
  let languages = [];
  if (types.length) {
    primary = types[0][0];
    languages = types.filter(([, s]) => s >= 2).map(([t]) => t);
    if (!languages.length) languages = [primary];
  } else if (Object.keys(langTotals).length) {
    primary = Object.entries(langTotals).sort((a, b) => b[1] - a[1])[0][0];
    languages = [primary];
  }

  // Mixed-language?
  const significant = types.filter(([, s]) => s >= 3).map(([t]) => t);
  const mixed = significant.length >= 2;
  if (mixed && primary !== 'unknown') {
    // keep highest as primary but flag mixed
  }

  // Framework refinement
  let frameworks = pkg ? detectFrameworks(abs, pkg) : [];
  if (entryNames.has('AndroidManifest.xml') || entryNames.has('settings.gradle')) {
    if (!frameworks.includes('android')) frameworks.push('android');
  }

  return {
    root: abs,
    primary,
    languages: mixed ? significant : languages,
    mixed,
    frameworks,
    scores,
    evidence: evidence.slice(0, 20),
    extCounts,
    hasGit: entryNames.has('.git'),
    hasPackageJson: entryNames.has('package.json'),
  };
}

if (require.main === module) {
  const root = process.argv[2];
  const asJson = process.argv.includes('--json');
  if (!root) {
    console.error('Usage: node detect.js <repoRoot> [--json]');
    process.exit(1);
  }
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) {
    console.error(`Repository not found: ${abs}`);
    process.exit(2);
  }
  const result = detect(abs);
  if (asJson || !process.stdout.isTTY) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`primary: ${result.primary}`);
    console.log(`languages: ${result.languages.join(', ') || '(none)'}`);
    console.log(`frameworks: ${result.frameworks.join(', ') || '(none)'}`);
    console.log(`mixed: ${result.mixed}`);
    for (const e of result.evidence) console.log(` - ${e}`);
  }
}

module.exports = { detect };
