'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detect } = require('../project-knowledge/detect');
const { buildContext } = require('../project-knowledge/context');

test('detect finds node for this repo', () => {
  const d = detect(__dirname + '/..');
  assert.equal(d.primary, 'node');
});

test('buildContext degrades without .project', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ctx-'));
  const ctx = buildContext(tmp, 'test');
  assert.match(ctx.text, /PROJECT CONTEXT/);
  assert.equal(ctx.hasKnowledge, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});
