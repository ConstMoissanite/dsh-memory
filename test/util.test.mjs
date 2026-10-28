import test from 'node:test';
import assert from 'node:assert/strict';
import { ftsQuery } from '../lib/util.js';

test('hybrid FTS joins identifier queries with AND', () => {
  assert.match(ftsQuery('MEM-REV3-ALPHA'), /"mem" AND "rev3" AND "alpha"/);
});

test('hybrid FTS keeps multi-word and Chinese queries recall-oriented', () => {
  assert.match(ftsQuery('gcc Windows'), /"gcc" OR "windows"/);
  assert.match(ftsQuery('环境遮蔽'), /OR/);
  assert.equal(ftsQuery('ALPHA'), '"alpha"');
  assert.equal(ftsQuery('   '), '');
});
