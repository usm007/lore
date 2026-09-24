'use strict';
/**
 * atomic.js — crash-safe file writes + cooperative cross-process locking.
 * No dependencies beyond Node.js built-ins. Works on Windows and POSIX.
 *
 * writeFileAtomicSync(target, content):
 *   writes to a unique temp file in the same directory, fsyncs, then renames
 *   over the target. Readers never see a half-written file, and a crash never
 *   leaves a corrupt target (at worst a stray .tmp file, cleaned on next run).
 *
 * withLockSync(lockDir, fn, opts):
 *   exclusive lock via atomic mkdir. Waits up to `timeoutMs` (default 15000),
 *   polling every `intervalMs` (default 50). A lock older than `staleMs`
 *   (default 60000) is treated as orphaned (crashed holder) and removed.
 *   Always releases the lock, even if fn throws.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const t = Date.now() + ms;
    while (Date.now() < t) { /* fallback busy-wait */ }
  }
}

function tmpName(dir) {
  return path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
}

function writeFileAtomicSync(target, content, opts = {}) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = tmpName(dir);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, content);
      if (opts.fsync !== false) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

/** Remove stray temp files from crashed writers (best effort, same-process safe). */
function cleanStaleTmpSync(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return 0; }
  let removed = 0;
  const now = Date.now();
  for (const e of entries) {
    if (!e.isFile() || !/^\.tmp-\d+-[0-9a-f]+$/.test(e.name)) continue;
    const p = path.join(dir, e.name);
    try {
      const age = now - fs.statSync(p).mtimeMs;
      if (age > 60000) { fs.unlinkSync(p); removed += 1; }
    } catch { /* ignore races */ }
  }
  return removed;
}

function lockAgeMs(lockDir) {
  // Prefer the marker's mtime (holder start); fall back to the dir mtime
  // (covers crash between mkdir and marker write).
  try { return Date.now() - fs.statSync(path.join(lockDir, 'lock')).mtimeMs; }
  catch {
    try { return Date.now() - fs.statSync(lockDir).mtimeMs; }
    catch { return Infinity; }
  }
}

function withLockSync(lockDir, fn, opts = {}) {
  const envTimeout = Number(process.env.PK_LOCK_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs
    : (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 15000);
  const intervalMs = opts.intervalMs || 50;
  const staleMs = opts.staleMs || 60000;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  // mkdir (non-recursive) is atomic: exactly one contender wins; the rest get
  // EEXIST. A fixed marker file records the holder for staleness checks.
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      try {
        fs.writeFileSync(path.join(lockDir, 'lock'), String(process.pid), { flag: 'wx' });
      } catch { /* lost a microscopic race; we still own the dir via mkdir */ }
      break; // lock acquired
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e; // real fs error (permissions, etc.)
    }
    if (lockAgeMs(lockDir) > staleMs) {
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* race: retry */ }
      continue;
    }
    if (Date.now() >= deadline) {
      const err = new Error(`Timed out waiting for lock: ${lockDir}`);
      err.code = 'PK_LOCK_TIMEOUT';
      throw err;
    }
    sleepMs(intervalMs);
  }
  try {
    return fn();
  } finally {
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = { writeFileAtomicSync, cleanStaleTmpSync, withLockSync };
