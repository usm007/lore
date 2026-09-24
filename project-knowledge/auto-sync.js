'use strict';
/**
 * opencode-project-knowledge — auto-sync.js
 * Full unattended knowledge sync. Local-only: no network (beyond the agent
 * runner's own provider calls), never commits, never pushes. All writes stay
 * inside <root>/.project/ (+ machine-local scheduler entries).
 *
 * Pipeline (each stage gated, idempotent, logged):
 *   0. bootstrap if .project/ absent (safe: never overwrites, respects .gitignore)
 *   1. mechanical.js (deterministic facts — always runs)
 *   2. refresh.js --mark-only (stale marking — always runs)
 *   3. agent semantic pass — ONLY if stale sections exist AND a headless
 *      `opencode run` runner is available. Otherwise logs and exits 0 so the
 *      next interactive session picks it up via /project-knowledge-refresh.
 *   4. refresh.js --clear when the agent pass reports success.
 *
 * The agent pass is deliberately scheduled (weekly), never per-commit:
 * per-commit hooks stay deterministic and instant (see install-hooks.js).
 *
 * CLI:
 *   node auto-sync.js <repoRoot> [--dry-run] [--json] [--quiet] [--force-agent]
 *   --force-agent runs the agent pass even with nothing marked stale (validation).
 * Exit codes: 0 ok (including graceful skip), 1 bad usage, 2 repo not found.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const ENGINE_DIR = __dirname;

function logLine(root, msg, quiet, toFile = true) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  if (toFile) {
    try {
      fs.mkdirSync(path.join(root, '.project', 'state'), { recursive: true });
      fs.appendFileSync(path.join(root, '.project', 'state', 'auto.log'), line);
    } catch { /* best effort */ }
  }
  if (!quiet) process.stdout.write(line);
}

function findRunner() {
  // 1. opencode on PATH with `run` subcommand support
  try {
    const help = execSync('opencode --help', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
    if (/^\s+run\b/m.test(help)) return { cmd: 'opencode', args: ['run'] };
  } catch { /* not on PATH or no help */ }
  // 2. repo-local / config-local installs (never installs anything itself)
  const candidates = [
    path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'opencode.cmd' : 'opencode'),
  ];
  const cfg = process.env.OPENCODE_CONFIG || path.join(require('os').homedir(), '.config', 'opencode');
  candidates.push(path.join(cfg, 'node_modules', '.bin', process.platform === 'win32' ? 'opencode.cmd' : 'opencode'));
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return { cmd: c, args: ['run'] };
    } catch { /* next */ }
  }
  return null;
}

function agentPrompt(root) {
  return `Project-knowledge unattended refresh for ${root}. ` +
    `Run /project-knowledge-refresh strictly scoped to modules marked stale in ` +
    `.project/state/stale.json (targeted edits only, keep FACT/INFERENCE/UNCERTAINTY ` +
    `labels, never touch source code, never commit). ` +
    `When done, run node ${ENGINE_DIR}/refresh.js ${root} --clear for the modules you resolved. ` +
    `Reply with a one-line summary per updated file.`;
}

function autoSync(root, opts = {}) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    const e = new Error(`Repository not found: ${abs}`);
    e.code = 'REPO_NOT_FOUND';
    throw e;
  }
  // No parent lock: each stage takes its own (mechanical/refresh/bootstrap all
  // lock internally). Holding one lock while spawning children deadlocks.
  // Agent-pass double-spend is prevented by a sentinel file instead.
  return autoSyncInner(abs, opts);
}

function agentSentinel(root) {
  return path.join(root, '.project', 'state', 'agent-run.json');
}
function sentinelActive(root, maxAgeMs) {
  try {
    const s = JSON.parse(fs.readFileSync(agentSentinel(root), 'utf8'));
    if (s && s.startedAt && Date.now() - Date.parse(s.startedAt) < maxAgeMs && !s.done) return s;
  } catch { /* absent or unreadable */
  }
  return null;
}

function autoSyncInner(abs, opts = {}) {
  const { mechanical } = require('./mechanical');
  const { refresh } = require('./refresh');
  const steps = [];
  const run = (label, fn) => {
    if (opts.dryRun) { steps.push(`${label} (would run)`); return { dry: true }; }
    const r = fn();
    steps.push(label);
    return r || {};
  };

  // 0. bootstrap when missing (safe by construction; ESM module run as child process)
  if (!fs.existsSync(path.join(abs, '.project'))) {
    if (opts.dryRun) {
      steps.push('bootstrap (.project absent) (would run)');
    } else {
      execFileSync(process.execPath, [path.join(ENGINE_DIR, 'bootstrap.mjs'), abs, '--no-hooks'], { stdio: 'pipe' });
      steps.push('bootstrap (.project absent)');
    }
  }

  // 1+2. deterministic stages, in-process (own locks, no nesting)
  run('mechanical sync', () => mechanical(abs, {}));
  run('refresh --mark-only', () => refresh(abs, { markOnly: true }));

  // stale gate
  let stale = [];
  try {
    const s = JSON.parse(fs.readFileSync(path.join(abs, '.project', 'state', 'stale.json'), 'utf8'));
    if (Array.isArray(s.stale)) stale = s.stale;
    else if (Array.isArray(s.affected)) stale = s.affected;
  } catch { stale = []; }

  let agent = { ran: false, reason: null };
  if (!stale.length && !opts.forceAgent) {
    agent = { ran: false, reason: 'nothing marked stale — deterministic stages were enough' };
    steps.push('agent pass skipped (clean)');
  } else {
    const prior = !opts.dryRun && !opts.forceAgent ? sentinelActive(abs, 4 * 3600 * 1000) : null;
    if (prior) {
      agent = { ran: false, reason: `recent agent run in progress (started ${prior.startedAt}) — skipping to avoid double-spend` };
      steps.push('agent pass skipped (sentinel active)');
    } else {
      const runner = findRunner();
      if (!runner) {
        agent = { ran: false, reason: 'no headless `opencode run` runner found — left for next interactive session' };
        steps.push('agent pass skipped (no runner)');
      } else if (opts.dryRun) {
        agent = { ran: true, reason: null, dry: true };
        steps.push(`agent pass (would run: ${runner.cmd} run "<refresh prompt>")`);
      } else {
        const { writeFileAtomicSync } = require('./atomic');
        writeFileAtomicSync(agentSentinel(abs), JSON.stringify({ startedAt: new Date().toISOString(), done: false }, null, 2) + '\n');
        try {
          const out = execFileSync(runner.cmd, [...runner.args, agentPrompt(abs)],
            { cwd: abs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
          agent = { ran: true, reason: null, summary: String(out).slice(-2000) };
          steps.push('agent pass ran');
          // re-sync machine fields AFTER the agent (preserves its keys), then clear resolved stale
          run('mechanical re-sync (post-agent)', () => mechanical(abs, {}));
          run('refresh --clear (agent reported success)', () => refresh(abs, { clear: true }));
          writeFileAtomicSync(agentSentinel(abs), JSON.stringify({ startedAt: new Date().toISOString(), done: true }, null, 2) + '\n');
        } catch (e) {
          agent = { ran: true, reason: `agent pass failed (stale left intact): ${String((e && e.message) || e).slice(0, 300)}` };
          steps.push('agent pass FAILED — stale left intact for next session');
          try { fs.unlinkSync(agentSentinel(abs)); } catch { /* retry next time */ }
        }
      }
    }
  }

  return { root: abs, dryRun: Boolean(opts.dryRun), steps, staleAtGate: stale, agent };
}

if (require.main === module) {
  const root = process.argv[2];
  const asJson = process.argv.includes('--json');
  const quiet = process.argv.includes('--quiet');
  if (!root || root === '--help' || root === '-h') {
    console.error('Usage: node auto-sync.js <repoRoot> [--dry-run] [--json] [--quiet] [--force-agent]');
    process.exit(1);
  }
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) { console.error(`Repository not found: ${abs}`); process.exit(2); }
  try {
    const res = autoSync(abs, { dryRun: process.argv.includes('--dry-run'), forceAgent: process.argv.includes('--force-agent') });
    const toFile = !res.dryRun;
    for (const s of res.steps) logLine(abs, `auto-sync: ${s}`, quiet || asJson, toFile);
    if (!quiet) {
      logLine(abs, `auto-sync done: agent ${res.agent.ran ? 'RAN' : 'skipped'}${res.agent.reason ? ` (${res.agent.reason})` : ''}`, asJson, toFile);
    }
    if (asJson) console.log(JSON.stringify({ ok: true, ...res }, null, 2));
    else if (quiet) console.log(`auto-sync: ${res.steps.length} steps, agent ${res.agent.ran ? 'RAN' : 'skipped'}`);
  } catch (e) {
    logLine(abs, `auto-sync ERROR: ${String((e && e.message) || e)}`, quiet);
    console.error(String((e && e.message) || e));
    process.exit(e && e.code === 'REPO_NOT_FOUND' ? 2 : 1);
  }
}

module.exports = { autoSync };
