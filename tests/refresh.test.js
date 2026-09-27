'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePorcelain, classify } = require('../project-knowledge/refresh');

test('parsePorcelain splits renames and untracked', () => {
  const out = 'R  old.ts -> new.ts\nM  src/a.js\n?? newfile.md\n';
  const { tracked, untracked } = parsePorcelain(out);
  assert.deepEqual(tracked, ['old.ts', 'new.ts', 'src/a.js']);
  assert.deepEqual(untracked, ['newfile.md']);
});

test('classify skips build output, binaries, .project', () => {
  const { meaningful, skipped } = classify([
    'src/a.js', 'dist/b.js', 'logo.png', '.project/overview.md', 'node_modules/x.js',
  ]);
  assert.deepEqual(meaningful, ['src/a.js']);
  assert.equal(skipped.length, 4);
});
