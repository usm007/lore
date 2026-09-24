'use strict';
/**
 * status.js — read-only knowledge status.
 * CLI: node status.js <repoRoot> [--json]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { detect } = require('./detect');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { __error: e.code === 'ENOENT' ? 'missing' : String(e.message || e) }; }
}

function gitChanged(root) {
  try {
    const out = execSync('git status --porcelain', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const { parsePorcelain } = require('./refresh');
    const { tracked, untracked } = parsePorcelain(out);
    return tracked.concat(untracked.map((f) => `?? ${f}`)).slice(0, 50);
  } catch { return null; } // git unavailable -> null (graceful)
}

function expectedDocs() {
  return ['overview.md', 'architecture.md', 'modules.md', 'data-flow.md', 'dependencies.md',
    'conventions.md', 'decisions.md', 'known-issues.md', 'test-map.md', 'knowledge.json'];
}

function status(root) {
  const abs = path.resolve(root);
  const detection = detect(abs);
  const pj = path.join(abs, '.project');
  const kj = readJson(path.join(pj, 'knowledge.json'));
  const stale = readJson(path.join(pj, 'state', 'stale.json'));
  const missing = expectedDocs().filter((d) => !fs.existsSync(path.join(pj, d)));
  const malformed = (kj && kj.__error && kj.__error !== 'missing') ? kj.__error : null;
  const changed = gitChanged(abs);

  let age = 'no baseline';
  if (kj && kj.generatedAt) {
    const days = Math.max(0, Math.floor((Date.now() - Date.parse(kj.generatedAt)) / 86400000));
    age = `${kj.generatedAt} (~${days}d ago)`;
  }
  return {
    root: abs,
    projectType: detection.primary,
    languages: detection.languages,
    frameworks: detection.frameworks,
    knowledgeAge: age,
    baseline: (kj && kj.baseline) || null,
    changedFiles: changed, // null => git unavailable
    staleSections: (stale && stale.stale) || [],
    missingKnowledge: missing,
    lowConfidence: (kj && kj.lowConfidence) || [],
    malformed,
    hasKnowledge: fs.existsSync(path.join(pj, 'overview.md')) || fs.existsSync(path.join(pj, 'knowledge.json')),
  };
}

function render(s) {
  const L = [];
  L.push('PROJECT KNOWLEDGE STATUS');
  L.push(`root: ${s.root}`);
  L.push(`detected type: ${s.projectType} (${(s.languages || []).join(', ') || 'n/a'})`);
  L.push(`knowledge age: ${s.knowledgeAge}`);
  L.push(`baseline: ${s.baseline ? `${s.baseline.commit || 'n/a'} @ ${s.baseline.timestamp || 'n/a'} (${s.baseline.fileCount ?? '?'} files)` : 'none'}`);
  L.push(`changed files: ${s.changedFiles === null ? 'git unavailable' : (s.changedFiles.length ? s.changedFiles.slice(0, 10).join(', ') + (s.changedFiles.length > 10 ? ` (+${s.changedFiles.length - 10} more)` : '') : 'clean')}`);
  L.push(`stale sections: ${s.staleSections.length ? s.staleSections.join('; ') : 'none'}`);
  L.push(`low-confidence: ${s.lowConfidence.length ? s.lowConfidence.join(', ') : 'none'}`);
  L.push(`missing knowledge: ${s.missingKnowledge.length ? s.missingKnowledge.join(', ') : 'none'}`);
  if (s.malformed) L.push(`malformed: knowledge.json: ${s.malformed}`);
  return L.join('\n');
}

if (require.main === module) {
  const root = process.argv[2];
  if (!root) { console.error('Usage: node status.js <repoRoot> [--json]'); process.exit(1); }
  if (!fs.existsSync(path.resolve(root))) { console.error(`Repository not found: ${root}`); process.exit(2); }
  const s = status(path.resolve(root));
  console.log(process.argv.includes('--json') ? JSON.stringify(s, null, 2) : render(s));
}

module.exports = { status };
