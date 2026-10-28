import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendSectionToContent,
  bodyHash,
  findSection,
  parseMemoryMarkdown,
  removeSectionFromContent,
  renderSection,
  replaceSectionInContent,
} from '../lib/markdown.js';

const SAMPLE = `# DSH Memory

## Interaction style
> Use when: replying to the user

Be concise.

## MinGW gcc
Use the toolchain compiler.
`;

test('parses headings, hints, bodies, and the preamble', () => {
  const parsed = parseMemoryMarkdown(SAMPLE);
  assert.equal(parsed.error, null);
  assert.equal(parsed.sections.length, 2);
  assert.equal(parsed.sections[0].heading, 'Interaction style');
  assert.equal(parsed.sections[0].hint, 'replying to the user');
  assert.equal(parsed.sections[0].body, 'Be concise.');
  assert.equal(parsed.sections[1].hint, '');
  assert.equal(parsed.sections[1].body, 'Use the toolchain compiler.');
  assert.match(parsed.preamble, /# DSH Memory/);
});

test('renders and replaces one section without touching the rest', () => {
  const parsed = parseMemoryMarkdown(SAMPLE);
  const target = findSection(parsed, 'interaction style');
  const next = replaceSectionInContent(SAMPLE, target, {
    heading: 'Interaction style',
    hint: 'answering any question',
    body: 'Be brief.',
  });
  const reparsed = parseMemoryMarkdown(next);
  assert.equal(reparsed.error, null);
  assert.equal(reparsed.sections.length, 2);
  assert.equal(reparsed.sections[0].hint, 'answering any question');
  assert.equal(reparsed.sections[0].body, 'Be brief.');
  assert.equal(reparsed.sections[1].body, 'Use the toolchain compiler.');
  assert.match(reparsed.preamble, /# DSH Memory/);
});

test('appends a section and removes it again', () => {
  const parsed = parseMemoryMarkdown(SAMPLE);
  const appended = appendSectionToContent(SAMPLE, {
    heading: 'Build flags',
    hint: 'building this task',
    body: 'Use -DDEBUG=1.',
  });
  const reparsed = parseMemoryMarkdown(appended);
  assert.equal(reparsed.sections.length, 3);
  assert.equal(reparsed.sections[2].body, 'Use -DDEBUG=1.');
  const removed = removeSectionFromContent(appended, reparsed.sections[1]);
  const final = parseMemoryMarkdown(removed);
  assert.equal(final.error, null);
  assert.equal(final.sections.length, 2);
  assert.equal(final.sections.some((section) => section.heading === 'MinGW gcc'), false);
});

test('rejects duplicate headings', () => {
  const parsed = parseMemoryMarkdown('# Memory\n\n## A\none\n\n## A\ntwo\n');
  assert.match(parsed.error, /duplicate heading/);
});

test('handles CJK headings and normalizes the key', () => {
  const parsed = parseMemoryMarkdown('## 环境 遮蔽\n\nGit 的 gcc 会遮蔽 Mingw64。\n');
  assert.equal(parsed.error, null);
  assert.equal(parsed.sections[0].heading, '环境 遮蔽');
  assert.equal(parsed.sections[0].headingKey, '环境 遮蔽');
});

test('body hashes ignore whitespace-only changes', () => {
  assert.equal(bodyHash('one  two\nthree'), bodyHash('one two three'));
});

test('renderSection round-trips through the parser', () => {
  const text = renderSection({ heading: 'Title', hint: 'when needed', body: 'Body text.' });
  const parsed = parseMemoryMarkdown(text);
  assert.equal(parsed.error, null);
  assert.equal(parsed.sections[0].heading, 'Title');
  assert.equal(parsed.sections[0].hint, 'needed');
  assert.equal(parsed.sections[0].body, 'Body text.');
  assert.doesNotMatch(text, /Use when: when/);
});
