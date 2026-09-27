'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { upsertBlock } = require('../project-knowledge/mechanical');

test('upsertBlock is idempotent on identical body', () => {
  const body = 'hello';
  const first = upsertBlock('# doc\n', 'versions', body);
  assert.equal(first.changed, true);
  const second = upsertBlock(first.content, 'versions', body);
  assert.equal(second.changed, false);
  assert.equal(second.mode, 'unchanged');
  assert.equal(second.content, first.content);
});

test('upsertBlock replaces changed body', () => {
  const first = upsertBlock('# doc\n', 'k', 'v1');
  const second = upsertBlock(first.content, 'k', 'v2');
  assert.equal(second.changed, true);
  assert.equal(second.mode, 'replaced');
  assert.match(second.content, /v2/);
});
