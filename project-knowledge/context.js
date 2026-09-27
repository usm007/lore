'use strict';
/**
 * opencode-project-knowledge — context.js
 * Produces a compact (~30-40 line) PROJECT CONTEXT from .project/ metadata.
 * Never injects whole knowledge base or source excerpts.
 *
 * CLI:
 *   node context.js <repoRoot> [taskHint] [--json]
 * Exit codes: 0 ok (context printed), 1 bad usage, 2 repo not found.
 * Prints context to stdout even when knowledge is missing (degraded mode).
 */

const fs = require('fs');
const path = require('path');
const { detect } = require('./detect');

function readIfExists(p, maxChars = 4000) {
  try {
    const s = fs.readFileSync(p, 'utf8');
    return s.length > maxChars ? s.slice(0, maxChars) + '\n…(truncated)' : s;
  } catch { return null; }
}

function readKnowledgeJson(root) {
  try {
    const raw = fs.readFileSync(path.join(root, '.project', 'knowledge.json'), 'utf8');
    return { data: JSON.parse(raw), malformed: false };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { data: null, malformed: false, missing: true };
    return { data: null, malformed: true, error: String(e && e.message || e) };
  }
}

function readStale(root) {
  try {
    const raw = fs.readFileSync(path.join(root, '.project', 'state', 'stale.json'), 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j.stale) ? j : { stale: [] };
  } catch { return { stale: [] }; }
}

function firstLines(s, n = 6) {
  if (!s) return null;
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^#+\s*$/.test(l));
  return lines.slice(0, n).join(' / ').slice(0, 400) || null;
}

function buildContext(root, taskHint = '') {
  const abs = path.resolve(root);
  const detection = detect(abs);
  const kj = readKnowledgeJson(abs);
  const stale = readStale(abs);
  const overview = readIfExists(path.join(abs, '.project', 'overview.md'));
  const modules = readIfExists(path.join(abs, '.project', 'modules.md'));
  const decisions = readIfExists(path.join(abs, '.project', 'decisions.md'));
  const issues = readIfExists(path.join(abs, '.project', 'known-issues.md'), 1200);

  const hasKnowledge = Boolean(overview || kj.data);
  const projectName = (kj.data && (kj.data.project || kj.data.name)) || path.basename(abs);
  const version = (kj.data && kj.data.version) || null;
  const baseline = (kj.data && kj.data.baseline) || null;
  const generatedAt = kj.data && kj.data.generatedAt;
  const baselineStamp = baseline && baseline.timestamp
    ? { at: baseline.timestamp, commit: baseline.commit || null }
    : (generatedAt ? { at: generatedAt, commit: null } : null);

  function ageDaysFor(stamp) {
    const ms = Date.parse(stamp);
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
  }

  let freshness = 'no .project/ baseline yet (bootstrap recommended)';
  let confidence = 'low';
  if (kj.malformed) { freshness = 'knowledge.json is malformed (repair recommended)'; confidence = 'low'; }
  else if (baselineStamp) {
    const ageDays = ageDaysFor(baselineStamp.at);
    const ageBits = ageDays === null ? '(unknown age)' : `(~${ageDays}d ago)`;
    const staleCount = stale.stale.length;
    const commitBits = baselineStamp.commit ? ` @ ${String(baselineStamp.commit).slice(0, 8)}` : '';
    freshness = `${baselineStamp.at}${commitBits} ${ageBits}${staleCount ? `; ${staleCount} stale area(s)` : '; clean'}`;
    confidence = staleCount > 3 ? 'medium' : 'high';
    if (kj.data.lowConfidence && kj.data.lowConfidence.length) confidence = 'medium';
  } else if (hasKnowledge) { freshness = 'partial knowledge (no baseline timestamp)'; confidence = 'medium'; }

  // Relevant subsystem: prefer task-hint keyword match against modules.md headings
  let relevant = 'general (see modules.md map)';
  if (taskHint && modules) {
    const hint = taskHint.toLowerCase().split(/[^a-z0-9_./-]+/).filter((w) => w.length > 2);
    const heads = modules.split('\n').filter((l) => /^#{1,4}\s+/.test(l));
    const hit = heads.find((h) => hint.some((w) => h.toLowerCase().includes(w)));
    if (hit) relevant = hit.replace(/^#+\s*/, '').slice(0, 120);
  } else if (modules) {
    const m = modules.split('\n').find((l) => /^#{1,4}\s+/.test(l));
    if (m) relevant = m.replace(/^#+\s*/, '').slice(0, 120);
  }

  const lines = [];
  lines.push('PROJECT CONTEXT');
  lines.push(`Project: ${projectName}${version ? ` (${version})` : ''}`);
  lines.push(`Type: ${detection.primary}${detection.mixed ? ' (mixed: ' + detection.languages.join('+') + ')' : ''}${detection.frameworks.length ? ' / ' + detection.frameworks.join(', ') : ''}`);
  lines.push(`Architecture: ${firstLines(overview, 2) || (kj.data && kj.data.architecture) || 'see .project/architecture.md (or bootstrap)'}`);
  lines.push(`Relevant subsystem: ${relevant}`);
  lines.push(`Relevant modules: ${firstLines(modules, 3) || 'see .project/modules.md'}`);
  lines.push(`Important constraints: ${firstLines(readIfExists(path.join(abs, '.project', 'conventions.md')), 2) || 'see .project/conventions.md'}`);
  lines.push(`Relevant decisions: ${firstLines(decisions, 2) || 'see .project/decisions.md'}`);
  if (issues && firstLines(issues, 1)) lines.push(`Known issues: ${firstLines(issues, 1)}`);
  lines.push(`Knowledge freshness: ${freshness}`);
  if (baseline) lines.push(`Baseline: ${baseline.commit || 'n/a'} @ ${baseline.timestamp || 'n/a'}`);
  lines.push(`Confidence: ${confidence}`);
  if (stale.stale.length) lines.push(`Stale: ${stale.stale.slice(0, 5).join('; ')}${stale.stale.length > 5 ? ` (+${stale.stale.length - 5} more)` : ''}`);
  if (!hasKnowledge) lines.push('Note: .project/ missing or partial — run bootstrap.mjs to create baseline; source code is authoritative.');
  if (kj.malformed) lines.push(`Note: knowledge.json parse error: ${kj.error}`);
  lines.push('Full details: read only the needed .project/*.md file(s) per the modules map; do not paste large source excerpts.');

  return { text: lines.join('\n'), detection, hasKnowledge, freshness, confidence };
}

if (require.main === module) {
  const root = process.argv[2];
  if (!root) {
    console.error('Usage: node context.js <repoRoot> [taskHint] [--json]');
    process.exit(1);
  }
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) {
    console.error(`Repository not found: ${abs}`);
    process.exit(2);
  }
  const asJson = process.argv.includes('--json');
  const hint = process.argv.slice(3).filter((a) => a !== '--json').join(' ');
  const ctx = buildContext(abs, hint);
  if (asJson) {
    const { text, detection, hasKnowledge, freshness, confidence } = ctx;
    console.log(JSON.stringify({
      text,
      detection: { primary: detection.primary, languages: detection.languages, mixed: detection.mixed, frameworks: detection.frameworks },
      hasKnowledge, freshness, confidence,
    }, null, 2));
  } else {
    console.log(ctx.text);
  }
}

module.exports = { buildContext };
