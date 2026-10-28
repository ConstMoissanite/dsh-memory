import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryDb } from '../lib/db.js';
import { MemoryService, MemoryError } from '../lib/service.js';
import { resolveConfig } from '../lib/config.js';
import { globalMemoryPath, sessionMemoryPath, workspaceMemoryPath } from '../lib/files.js';
import { parseMemoryMarkdown, removeSectionFromContent } from '../lib/markdown.js';
import { workspaceKey } from '../lib/util.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-store-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const other = path.join(root, 'other');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const db = new MemoryDb(path.join(home, 'memory', 'index.db'));
  const service = new MemoryService({ homeDir: home, db });
  const config = resolveConfig({ homeDir: home, workspaceDir: workspace, pluginConfig: {} });
  return {
    root,
    home,
    workspace,
    other,
    db,
    service,
    config,
    cleanup: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('writes and reads global, workspace, and session scopes', () => {
  const fx = fixture();
  try {
    fx.service.writeSection({ scope: 'global', workspaceDir: fx.workspace, sessionId: 's1', heading: 'Interaction style', hint: 'replying to the user', text: 'Be concise.', confidence: 0.9, tags: ['style'] });
    fx.service.writeSection({ scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1', heading: 'MinGW gcc', hint: 'compiling C on Windows', text: 'Use the toolchain compiler.' });
    fx.service.writeSection({ scope: 'session', workspaceDir: fx.workspace, sessionId: 's1', heading: 'Build flags', hint: 'building this task', text: 'Use -DDEBUG=1.' });

    assert.equal(fx.service.readSection({ scope: 'auto', heading: 'Interaction style', workspaceDir: fx.workspace, sessionId: 's1' }).body, 'Be concise.');
    assert.equal(fx.service.readSection({ scope: 'auto', heading: 'MinGW gcc', workspaceDir: fx.workspace, sessionId: 's1' }).body, 'Use the toolchain compiler.');
    assert.equal(fx.service.readSection({ scope: 'auto', heading: 'Build flags', workspaceDir: fx.workspace, sessionId: 's1' }).body, 'Use -DDEBUG=1.');

    const global = fx.service.readSection({ scope: 'global', heading: 'Interaction style', workspaceDir: fx.workspace, sessionId: 's1' });
    assert.deepEqual(global.tags, ['style']);
    assert.equal(global.confidence, 0.9);

    for (const file of [
      globalMemoryPath(fx.home),
      workspaceMemoryPath(fx.home, fx.workspace),
      sessionMemoryPath(fx.home, fx.workspace, 's1'),
    ]) {
      assert.ok(fs.existsSync(file), `missing ${file}`);
    }
  } finally {
    fx.cleanup();
  }
});

test('isolates workspaces and sessions while sharing global entries', () => {
  const fx = fixture();
  try {
    fx.service.writeSection({ scope: 'global', workspaceDir: fx.workspace, sessionId: 's1', heading: 'Global note', text: 'visible everywhere' });
    fx.service.writeSection({ scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1', heading: 'Workspace A', text: 'only A' });
    fx.service.writeSection({ scope: 'workspace', workspaceDir: fx.other, sessionId: 's2', heading: 'Workspace B', text: 'only B' });
    fx.service.writeSection({ scope: 'session', workspaceDir: fx.workspace, sessionId: 's1', heading: 'Session note', text: 'only s1' });

    assert.equal(fx.service.readSection({ scope: 'workspace', heading: 'Workspace A', workspaceDir: fx.workspace, sessionId: 's1' }).body, 'only A');
    assert.equal(fx.service.readSection({ scope: 'workspace', heading: 'Workspace A', workspaceDir: fx.other, sessionId: 's2' }), null);
    assert.equal(fx.service.readSection({ scope: 'auto', heading: 'Global note', workspaceDir: fx.other, sessionId: 's2' }).body, 'visible everywhere');
    assert.equal(fx.service.readSection({ scope: 'auto', heading: 'Session note', workspaceDir: fx.other, sessionId: 's2' }), null);
    assert.equal(fx.service.readSection({ scope: 'session', heading: 'Session note', workspaceDir: fx.workspace, sessionId: 's1' }).body, 'only s1');

    const results = fx.service.search({ query: 'only', scope: 'all', workspaceDir: fx.workspace, sessionId: 's1', limit: 20 });
    assert.deepEqual(results.map((row) => row.heading).sort(), ['Session note', 'Workspace A']);
    assert.equal(workspaceKey(fx.workspace) === workspaceKey(fx.other), false);
  } finally {
    fx.cleanup();
  }
});

test('searches Chinese bigrams and English tokens', () => {
  const fx = fixture();
  try {
    fx.service.writeSection({
      scope: 'workspace',
      workspaceDir: fx.workspace,
      sessionId: 's1',
      heading: '环境遮蔽',
      hint: '编译 C 代码且 gcc 指向 Git 的 MinGW64 时',
      text: 'Git 自带的 MinGW64 gcc 会遮蔽目标编译器，应使用工具链里的 gcc。',
    });
    assert.equal(fx.service.search({ query: '环境', scope: 'all', workspaceDir: fx.workspace, sessionId: 's1', limit: 5 }).length, 1);
    assert.equal(fx.service.search({ query: '目标编译器', scope: 'all', workspaceDir: fx.workspace, sessionId: 's1', limit: 5 }).length, 1);
    assert.equal(fx.service.search({ query: 'gcc', scope: 'all', workspaceDir: fx.workspace, sessionId: 's1', limit: 5 }).length, 1);
    assert.equal(fx.service.search({ query: '完全不存在', scope: 'all', workspaceDir: fx.workspace, sessionId: 's1', limit: 5 }).length, 0);
  } finally {
    fx.cleanup();
  }
});

test('quarantines a manual edit until it is approved', () => {
  const fx = fixture();
  try {
    fx.service.writeSection({ scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1', heading: 'Topic', hint: 'when needed', text: 'old body' });
    const file = workspaceMemoryPath(fx.home, fx.workspace);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('old body', 'new body'));

    const anomalies = fx.service.listAnomalies({ workspaceDir: fx.workspace, sessionId: 's1' });
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].kind, 'section');
    assert.equal(anomalies[0].reason, 'modified');
    assert.equal(anomalies[0].old, 'old body');
    assert.equal(anomalies[0].new, 'new body');
    assert.equal(fx.service.readSection({ scope: 'workspace', heading: 'Topic', workspaceDir: fx.workspace, sessionId: 's1' }), null);

    fx.service.approveAnomaly({ scope: 'workspace', heading: 'Topic', workspaceDir: fx.workspace, sessionId: 's1' });
    assert.equal(fx.service.readSection({ scope: 'workspace', heading: 'Topic', workspaceDir: fx.workspace, sessionId: 's1' }).body, 'new body');
    assert.equal(fx.service.listAnomalies({ workspaceDir: fx.workspace, sessionId: 's1' }).length, 0);
  } finally {
    fx.cleanup();
  }
});

test('quarantines a manual removal and tombstones after approval', () => {
  const fx = fixture();
  try {
    fx.service.writeSection({ scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1', heading: 'Remove me', text: 'gone' });
    const file = workspaceMemoryPath(fx.home, fx.workspace);
    const content = fs.readFileSync(file, 'utf8');
    const parsed = parseMemoryMarkdown(content);
    fs.writeFileSync(file, removeSectionFromContent(content, parsed.sections[0]));

    const anomalies = fx.service.listAnomalies({ workspaceDir: fx.workspace, sessionId: 's1' });
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].reason, 'removed');
    assert.equal(anomalies[0].new, null);

    fx.service.approveAnomaly({ scope: 'workspace', heading: 'Remove me', workspaceDir: fx.workspace, sessionId: 's1' });
    assert.equal(fx.service.readSection({ scope: 'workspace', heading: 'Remove me', workspaceDir: fx.workspace, sessionId: 's1' }), null);
    assert.equal(fx.db.countTombstones(), 1);
  } finally {
    fx.cleanup();
  }
});

test('reports parse errors and rebuilds after a fix', () => {
  const fx = fixture();
  try {
    const file = globalMemoryPath(fx.home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# DSH Memory\n\n## A\none\n\n## A\ntwo\n');
    const anomalies = fx.service.listAnomalies({ workspaceDir: fx.workspace, sessionId: 's1' });
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].kind, 'file');
    assert.match(anomalies[0].error, /duplicate heading/);
    assert.equal(fx.service.readSection({ scope: 'global', heading: 'A', workspaceDir: fx.workspace, sessionId: 's1' }), null);

    fs.writeFileSync(file, '# DSH Memory\n\n## A\none\n');
    fx.service.rebuildAnomaly({ scope: 'global', workspaceDir: fx.workspace, sessionId: 's1' });
    assert.equal(fx.service.readSection({ scope: 'global', heading: 'A', workspaceDir: fx.workspace, sessionId: 's1' }).body, 'one');
    assert.equal(fx.service.listAnomalies({ workspaceDir: fx.workspace, sessionId: 's1' }).length, 0);
  } finally {
    fx.cleanup();
  }
});

test('hybrid search requires all parts of a no-space Latin identifier', () => {
  const fx = fixture();
  try {
    const base = { scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1', heading: 'MEM-REV3-ENTRY', hint: 'when testing identifiers' };
    fx.service.writeSection({ ...base, text: 'unique ALPHA token' });
    assert.equal(fx.service.search({ query: 'MEM-REV3-ALPHA', scope: 'all', workspaceDir: fx.workspace, sessionId: 's1', limit: 5 }).length, 1);
    assert.equal(fx.service.search({ query: 'ALPHA', scope: 'all', workspaceDir: fx.workspace, sessionId: 's1', limit: 5 }).length, 1);

    fx.service.writeSection({ ...base, text: 'unique BETA token', replace: true });
    assert.equal(fx.service.search({ query: 'MEM-REV3-ALPHA', scope: 'all', workspaceDir: fx.workspace, sessionId: 's1', limit: 5 }).length, 0);
    assert.equal(fx.service.search({ query: 'ALPHA', scope: 'all', workspaceDir: fx.workspace, sessionId: 's1', limit: 5 }).length, 0);
    assert.equal(fx.service.search({ query: 'BETA', scope: 'all', workspaceDir: fx.workspace, sessionId: 's1', limit: 5 }).length, 1);
    assert.equal(fx.service.search({ query: 'MEM-REV3 BETA', scope: 'all', workspaceDir: fx.workspace, sessionId: 's1', limit: 5 }).length, 1);
  } finally {
    fx.cleanup();
  }
});

test('renames an entry in place and preserves metadata', () => {
  const fx = fixture();
  try {
    fx.service.writeSection({
      scope: 'workspace',
      workspaceDir: fx.workspace,
      sessionId: 's1',
      heading: 'OLDTITLE',
      hint: 'condition x',
      text: 'unique body',
      tags: ['keep'],
      confidence: 0.7,
    });
    const result = fx.service.renameSection({
      scope: 'workspace',
      workspaceDir: fx.workspace,
      sessionId: 's1',
      previousHeading: 'OLDTITLE',
      heading: 'NEWTITLE',
    });
    assert.equal(result.renamed, true);
    assert.equal(fx.service.readSection({ scope: 'workspace', heading: 'OLDTITLE', workspaceDir: fx.workspace, sessionId: 's1' }), null);
    const row = fx.service.readSection({ scope: 'workspace', heading: 'NEWTITLE', workspaceDir: fx.workspace, sessionId: 's1' });
    assert.equal(row.body, 'unique body');
    assert.equal(row.hint, 'condition x');
    assert.deepEqual(row.tags, ['keep']);
    assert.equal(row.confidence, 0.7);
    assert.equal(fx.service.listAnomalies({ workspaceDir: fx.workspace, sessionId: 's1' }).length, 0);
    assert.equal(fx.service.search({ query: 'OLDTITLE', scope: 'all', workspaceDir: fx.workspace, sessionId: 's1', limit: 5 }).length, 0);
    assert.equal(fx.service.search({ query: 'NEWTITLE', scope: 'all', workspaceDir: fx.workspace, sessionId: 's1', limit: 5 }).length, 1);
  } finally {
    fx.cleanup();
  }
});

test('rejects a rename onto an existing heading', () => {
  const fx = fixture();
  try {
    const base = { scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1' };
    fx.service.writeSection({ ...base, heading: 'A', hint: 'when a', text: 'a body' });
    fx.service.writeSection({ ...base, heading: 'B', hint: 'when b', text: 'b body' });
    assert.throws(
      () => fx.service.renameSection({ ...base, previousHeading: 'A', heading: 'B' }),
      (error) => error instanceof MemoryError && error.code === 'CONFLICT',
    );
    assert.equal(fx.service.readSection({ ...base, heading: 'A' }).body, 'a body');
    assert.equal(fx.service.readSection({ ...base, heading: 'B' }).body, 'b body');
  } finally {
    fx.cleanup();
  }
});

test('pairs a manual heading rename and approves it in place', () => {
  const fx = fixture();
  try {
    fx.service.writeSection({
      scope: 'workspace',
      workspaceDir: fx.workspace,
      sessionId: 's1',
      heading: 'OLDTITLE',
      hint: 'condition y',
      text: 'same body',
      tags: ['keep'],
      confidence: 0.65,
    });
    const file = workspaceMemoryPath(fx.home, fx.workspace);
    const content = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, content.replace('## OLDTITLE', '## NEWTITLE'));

    const anomalies = fx.service.listAnomalies({ workspaceDir: fx.workspace, sessionId: 's1' });
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].reason, 'renamed');
    assert.equal(anomalies[0].oldHeading, 'OLDTITLE');
    assert.equal(anomalies[0].heading, 'NEWTITLE');
    assert.equal(anomalies[0].fromHeading, 'OLDTITLE');

    fx.service.approveAnomaly({
      scope: 'workspace',
      heading: 'NEWTITLE',
      fromHeading: 'OLDTITLE',
      workspaceDir: fx.workspace,
      sessionId: 's1',
    });
    assert.equal(fx.service.readSection({ scope: 'workspace', heading: 'OLDTITLE', workspaceDir: fx.workspace, sessionId: 's1' }), null);
    const row = fx.service.readSection({ scope: 'workspace', heading: 'NEWTITLE', workspaceDir: fx.workspace, sessionId: 's1' });
    assert.equal(row.body, 'same body');
    assert.deepEqual(row.tags, ['keep']);
    assert.equal(row.confidence, 0.65);
    assert.equal(fx.service.listAnomalies({ workspaceDir: fx.workspace, sessionId: 's1' }).length, 0);
  } finally {
    fx.cleanup();
  }
});

test('compacts a scope, preserves metadata, and tombstones omitted entries', () => {
  const fx = fixture();
  try {
    const base = { scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1' };
    fx.service.writeSection({ ...base, heading: 'Keep', hint: 'keep hint', text: 'keep body', tags: ['keep'], confidence: 0.7 });
    fx.service.writeSection({ ...base, heading: 'Edit', hint: 'edit hint', text: 'old edit', tags: ['edit'], confidence: 0.6 });
    fx.service.writeSection({ ...base, heading: 'Drop', hint: 'drop hint', text: 'drop body', tags: ['drop'], confidence: 0.5 });

    const result = fx.service.compactScope({
      ...base,
      entries: [
        { heading: 'Keep', text: 'keep body' },
        { heading: 'Edit', text: 'new edit', hint: 'new hint', tags: ['edited'], confidence: 0.9 },
        { heading: 'New', text: 'new body', hint: 'new hint' },
      ],
    });
    assert.equal(result.kept, 3);
    assert.equal(result.added, 1);
    assert.equal(result.removed, 1);

    const list = fx.service.list({ ...base, limit: 10 });
    assert.deepEqual(list.map((row) => row.heading).sort(), ['Edit', 'Keep', 'New']);

    const keep = fx.service.readSection({ ...base, heading: 'Keep' });
    assert.equal(keep.hint, 'keep hint');
    assert.deepEqual(keep.tags, ['keep']);
    assert.equal(keep.confidence, 0.7);

    const edit = fx.service.readSection({ ...base, heading: 'Edit' });
    assert.equal(edit.body, 'new edit');
    assert.equal(edit.hint, 'new hint');
    assert.deepEqual(edit.tags, ['edited']);
    assert.equal(edit.confidence, 0.9);

    assert.equal(fx.service.readSection({ ...base, heading: 'Drop' }), null);
    assert.ok(fx.db.countTombstones() >= 1);
    assert.equal(fx.service.listAnomalies({ workspaceDir: fx.workspace, sessionId: 's1' }).length, 0);
  } finally {
    fx.cleanup();
  }
});

test('rejects a same-heading different-content write without replace', () => {
  const fx = fixture();
  try {
    fx.service.writeSection({ scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1', heading: 'Conflict', hint: 'when needed', text: 'one' });
    assert.throws(
      () => fx.service.writeSection({ scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1', heading: 'conflict', hint: 'when needed', text: 'two' }),
      (error) => error instanceof MemoryError && error.code === 'CONFLICT',
    );
    assert.equal(fx.service.readSection({ scope: 'workspace', heading: 'Conflict', workspaceDir: fx.workspace, sessionId: 's1' }).body, 'one');

    const replaced = fx.service.writeSection({ scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1', heading: 'Conflict', hint: 'when needed', text: 'two', replace: true });
    assert.equal(replaced.replaced, true);
    assert.equal(fx.service.readSection({ scope: 'workspace', heading: 'Conflict', workspaceDir: fx.workspace, sessionId: 's1' }).body, 'two');

    const unchanged = fx.service.writeSection({ scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1', heading: 'Conflict', hint: 'when needed', text: 'two', tags: ['updated'], confidence: 0.4 });
    assert.equal(unchanged.unchanged, true);
    const row = fx.service.readSection({ scope: 'workspace', heading: 'Conflict', workspaceDir: fx.workspace, sessionId: 's1' });
    assert.deepEqual(row.tags, ['updated']);
    assert.equal(row.confidence, 0.4);
  } finally {
    fx.cleanup();
  }
});

test('allows the same heading in a different scope', () => {
  const fx = fixture();
  try {
    fx.service.writeSection({ scope: 'global', workspaceDir: fx.workspace, sessionId: 's1', heading: 'Shared', hint: 'when needed', text: 'global body' });
    const workspace = fx.service.writeSection({ scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1', heading: 'Shared', hint: 'when needed', text: 'workspace body' });
    assert.equal(workspace.replaced, false);
    assert.equal(fx.service.readSection({ scope: 'workspace', heading: 'Shared', workspaceDir: fx.workspace, sessionId: 's1' }).body, 'workspace body');
    assert.equal(fx.service.readSection({ scope: 'global', heading: 'Shared', workspaceDir: fx.workspace, sessionId: 's1' }).body, 'global body');
  } finally {
    fx.cleanup();
  }
});

test('replaces same-heading writes with explicit replace and forgets with confirmation', () => {
  const fx = fixture();
  try {
    const first = fx.service.writeSection({ scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1', heading: 'Same', hint: 'when', text: 'one' });
    assert.equal(first.replaced, false);
    const second = fx.service.writeSection({ scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1', heading: 'same', hint: 'when', text: 'two', replace: true });
    assert.equal(second.replaced, true);
    assert.equal(fx.service.list({ scope: 'workspace', workspaceDir: fx.workspace, sessionId: 's1', limit: 10 }).length, 1);
    assert.equal(fx.service.readSection({ scope: 'workspace', heading: 'Same', workspaceDir: fx.workspace, sessionId: 's1' }).body, 'two');

    assert.throws(
      () => fx.service.forget({ scope: 'workspace', heading: 'Same', workspaceDir: fx.workspace, sessionId: 's1', confirm: false }),
      (error) => error instanceof MemoryError && error.code === 'CONFIRM_REQUIRED',
    );
    fx.service.forget({ scope: 'workspace', heading: 'Same', workspaceDir: fx.workspace, sessionId: 's1', confirm: true });
    assert.equal(fx.service.readSection({ scope: 'workspace', heading: 'Same', workspaceDir: fx.workspace, sessionId: 's1' }), null);
    assert.equal(fx.db.countTombstones(), 1);
  } finally {
    fx.cleanup();
  }
});
