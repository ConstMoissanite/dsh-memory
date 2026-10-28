import path from 'node:path';
import {
  appendSectionToContent,
  bodyHash,
  findSection,
  parseMemoryMarkdown,
  removeSectionFromContent,
  renderSection,
  replaceSectionInContent,
} from './markdown.js';
import {
  atomicWriteText,
  ensureDir,
  globalMemoryPath,
  readTextOrNull,
  sessionMemoryPath,
  statOrNull,
  workspaceMemoryPath,
} from './files.js';
import { collapseWhitespace, normalizeHeading, sha1, truncateText, workspaceKey } from './util.js';
import { planInjection, renderVerbosity } from './inject.js';

export class MemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
  }
}

function snippetFor(row, query) {
  const body = String(row.body ?? '');
  const tokens = normalizeHeading(query).split(/\s+/).filter((token) => token.length >= 2);
  for (const token of tokens) {
    const index = body.toLowerCase().indexOf(token);
    if (index >= 0) {
      const start = Math.max(0, index - 80);
      return truncateText(body.slice(start, start + 200).replace(/\s+/g, ' ').trim(), 200);
    }
  }
  return truncateText(body.replace(/\s+/g, ' ').trim(), 200);
}

function normalizeHint(value) {
  return collapseWhitespace(
    String(value ?? '')
      .replace(/^use when\s*:\s*/i, '')
      .replace(/^when\s+/i, ''),
  );
}

export class MemoryService {
  constructor({ homeDir, db, logger } = {}) {
    this.homeDir = homeDir;
    this.db = db;
    this.logger = logger;
  }

  paths({ workspaceDir, sessionId } = {}) {
    return {
      global: globalMemoryPath(this.homeDir),
      workspace: workspaceDir ? workspaceMemoryPath(this.homeDir, workspaceDir) : null,
      session: workspaceDir && sessionId ? sessionMemoryPath(this.homeDir, workspaceDir, sessionId) : null,
    };
  }

  pathForScope(scope, context) {
    const paths = this.paths(context);
    const filePath = paths[scope];
    if (!filePath) {
      throw new MemoryError('NO_CONTEXT', `${scope} memory needs a workspace${scope === 'session' ? ' and session' : ''}`);
    }
    return filePath;
  }

  syncContext({ workspaceDir, sessionId, force = false } = {}) {
    const paths = this.paths({ workspaceDir, sessionId });
    const key = workspaceDir ? workspaceKey(workspaceDir) : '';
    const results = {};
    for (const [scope, filePath] of Object.entries(paths)) {
      if (!filePath) continue;
      results[scope] = this.syncFile({ scope, path: filePath, workspaceKey: key, sessionId, force });
    }
    return results;
  }

  /**
   * Reconcile one Markdown file against the SQLite projection. A changed
   * entry is quarantined (`status = 1`) and keeps its last-good body; the
   * Markdown remains the proposed new text until the user approves it.
   * Tool/UI writes pass `trustedHeadings` so their own edit stays active.
   */
  syncFile({ scope, path: filePath, workspaceKey: key = '', sessionId = '', force = false, trustedHeadings = null }) {
    const stat = statOrNull(filePath);
    const existingFile = this.db.getFileByPath(filePath);
    if (stat === null) {
      if (existingFile) {
        const rows = this.db.listSectionsForFile(existingFile.id);
        this.db.transaction(() => {
          for (const row of rows) {
            this.db.insertTombstone({ scope: existingFile.scope, headingKey: row.headingKey, bodyHash: row.bodyHash });
          }
          this.db.deleteFile(existingFile.id);
        });
      }
      return { status: 'missing' };
    }

    const content = readTextOrNull(filePath);
    if (content === null) return { status: 'missing' };
    const contentHash = sha1(content);
    if (!force && existingFile && existingFile.status === 0 && existingFile.content_hash === contentHash) {
      return { status: 'unchanged', file: existingFile };
    }

    const parsed = parseMemoryMarkdown(content);
    if (parsed.error !== null) {
      const row = existingFile ?? this.db.ensureFile({ scope, path: filePath, workspaceKey: key, sessionId });
      this.db.transaction(() => {
        this.db.setFileError(row.id, { mtime: stat.mtimeMs, size: stat.size, error: parsed.error });
      });
      return { status: 'error', error: parsed.error, file: this.db.getFileById(row.id) };
    }

    const trusted = trustedHeadings instanceof Set ? trustedHeadings : new Set(trustedHeadings ?? []);
    return this.db.transaction(() => {
      const row = existingFile ?? this.db.ensureFile({ scope, path: filePath, workspaceKey: key, sessionId });
      const existing = this.db.listSectionsForFile(row.id);
      const byKey = new Map(existing.map((section) => [section.headingKey, section]));
      const seen = new Set();
      const now = Date.now();

      for (const section of parsed.sections) {
        seen.add(section.headingKey);
        const current = byKey.get(section.headingKey);
        const isTrusted = trusted.has(section.headingKey);
        if (current) {
          if (isTrusted || current.bodyHash === section.bodyHash) {
            this.db.updateSection(current.id, {
              heading: section.heading,
              headingKey: section.headingKey,
              hint: section.hint,
              body: section.body,
              bodyHash: section.bodyHash,
              lineStart: section.startLine,
              lineEnd: section.endLine,
              status: 0,
              reason: '',
            });
            if (isTrusted) this.db.updateMeta(current.id, { updatedAt: now });
          } else {
            this.db.updateSection(current.id, {
              heading: section.heading,
              hint: section.hint,
              lineStart: section.startLine,
              lineEnd: section.endLine,
              status: 1,
              reason: 'modified',
            });
          }
        } else {
          this.db.insertSection({
            fileId: row.id,
            heading: section.heading,
            headingKey: section.headingKey,
            hint: section.hint,
            body: isTrusted ? section.body : '',
            bodyHash: isTrusted ? section.bodyHash : '',
            lineStart: section.startLine,
            lineEnd: section.endLine,
            status: isTrusted ? 0 : 1,
            reason: isTrusted ? '' : 'added',
            tags: [],
            confidence: 0.8,
            sourceSessionId: sessionId,
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      for (const current of existing) {
        if (seen.has(current.headingKey)) continue;
        if (current.status === 1 && current.body === '') {
          this.db.deleteSectionRow(current.id);
          continue;
        }
        if (current.status !== 1 || current.reason !== 'removed') {
          this.db.updateSection(current.id, { status: 1, reason: 'removed' });
        }
      }

      this.db.setFileSynced(row.id, { mtime: stat.mtimeMs, size: stat.size, contentHash });
      return { status: 'synced', file: this.db.getFileById(row.id) };
    });
  }

  ensureMemoryFile(filePath, scope) {
    const existing = readTextOrNull(filePath);
    if (existing !== null) return existing;
    ensureDir(path.dirname(filePath));
    const content = `# DSH Memory${scope === 'global' ? '' : ` — ${scope}`}\n\n`;
    atomicWriteText(filePath, content);
    return content;
  }

  writeSection({ scope, workspaceDir, sessionId, heading, hint, text, tags, confidence, replace = false }) {
    const filePath = this.pathForScope(scope, { workspaceDir, sessionId });
    const headingKey = normalizeHeading(heading);
    if (headingKey === '') throw new MemoryError('INVALID_HEADING', 'heading must contain searchable text');
    const content = this.ensureMemoryFile(filePath, scope);
    const parsed = parseMemoryMarkdown(content);
    if (parsed.error !== null) throw new MemoryError('FILE_INVALID', parsed.error);
    const existing = findSection(parsed, headingKey);
    const nextSection = { heading: heading.trim(), hint: hint ?? '', body: text };
    let unchanged = false;
    if (existing) {
      const sameBody = existing.bodyHash === bodyHash(text);
      const sameHint = normalizeHint(existing.hint) === normalizeHint(hint);
      unchanged = sameBody && sameHint;
      if (!replace && !unchanged) {
        throw new MemoryError(
          'CONFLICT',
          `a ${scope} memory named "${existing.heading}" already exists with different content; use a different heading or set replace: true`,
        );
      }
    }
    const nextContent = existing
      ? replaceSectionInContent(content, existing, nextSection)
      : appendSectionToContent(content, nextSection);
    atomicWriteText(filePath, nextContent);
    this.syncFile({
      scope,
      path: filePath,
      workspaceKey: workspaceDir ? workspaceKey(workspaceDir) : '',
      sessionId,
      force: true,
      trustedHeadings: new Set([headingKey]),
    });
    const fileRow = this.db.getFileByPath(filePath);
    const row = fileRow ? this.db.sectionByHeading(fileRow.id, headingKey) : null;
    if (row && (tags !== undefined || confidence !== undefined)) {
      this.db.updateMeta(row.id, {
        tags: tags ?? row.tags,
        confidence: confidence ?? row.confidence,
        sourceSessionId: sessionId ?? row.sourceSessionId,
        createdAt: row.createdAt || Date.now(),
        updatedAt: Date.now(),
      });
    }
    return {
      scope,
      heading: nextSection.heading,
      replaced: Boolean(existing),
      unchanged,
      filePath,
    };
  }

  renameSection({ scope, workspaceDir, sessionId, previousHeading, heading, hint, text, tags, confidence }) {
    const filePath = this.pathForScope(scope, { workspaceDir, sessionId });
    const oldKey = normalizeHeading(previousHeading);
    const newKey = normalizeHeading(heading);
    if (oldKey === '' || newKey === '') {
      throw new MemoryError('INVALID_HEADING', 'previousHeading and heading must contain searchable text');
    }
    const key = workspaceDir ? workspaceKey(workspaceDir) : '';
    if (readTextOrNull(filePath) === null) {
      throw new MemoryError('NOT_FOUND', `no ${scope} memory named "${previousHeading}"`);
    }
    this.syncFile({ scope, path: filePath, workspaceKey: key, sessionId });
    const content = readTextOrNull(filePath);
    if (content === null) throw new MemoryError('NOT_FOUND', `no ${scope} memory named "${previousHeading}"`);
    const parsed = parseMemoryMarkdown(content);
    if (parsed.error !== null) throw new MemoryError('FILE_INVALID', parsed.error);
    const oldSection = findSection(parsed, oldKey);
    if (!oldSection) throw new MemoryError('NOT_FOUND', `no ${scope} memory named "${previousHeading}"`);
    if (newKey !== oldKey && findSection(parsed, newKey)) {
      throw new MemoryError('CONFLICT', `a ${scope} memory named "${heading}" already exists`);
    }
    const nextBody = text === undefined ? oldSection.body : text;
    const nextHint = hint === undefined ? oldSection.hint : hint;
    const nextSection = { heading: heading.trim(), hint: nextHint, body: nextBody };
    const nextContent = replaceSectionInContent(content, oldSection, nextSection);
    atomicWriteText(filePath, nextContent);
    const parsedNext = parseMemoryMarkdown(nextContent);
    if (parsedNext.error !== null) throw new MemoryError('FILE_INVALID', parsedNext.error);
    const newSection = findSection(parsedNext, newKey);
    if (!newSection) throw new MemoryError('INDEX_FAILED', 'rename did not produce the expected section');
    const fileRow = this.db.getFileByPath(filePath);
    if (!fileRow) throw new MemoryError('INDEX_FAILED', 'memory file is not indexed');
    const oldRow = this.db.sectionByHeading(fileRow.id, oldKey);
    if (!oldRow) throw new MemoryError('INDEX_FAILED', 'previous memory is not indexed');
    const stat = statOrNull(filePath);
    const now = Date.now();
    this.db.transaction(() => {
      if (newKey !== oldKey) {
        const collision = this.db.sectionByHeading(fileRow.id, newKey);
        if (collision && collision.id !== oldRow.id) this.db.deleteSectionRow(collision.id);
      }
      this.db.updateSection(oldRow.id, {
        heading: nextSection.heading,
        headingKey: newKey,
        hint: nextHint,
        body: nextBody,
        bodyHash: bodyHash(nextBody),
        lineStart: newSection.startLine,
        lineEnd: newSection.endLine,
        status: 0,
        reason: '',
      });
      this.db.updateMeta(oldRow.id, {
        tags: tags ?? oldRow.tags,
        confidence: confidence ?? oldRow.confidence,
        sourceSessionId: sessionId ?? oldRow.sourceSessionId,
        createdAt: oldRow.createdAt || now,
        updatedAt: now,
      });
      if (stat) {
        this.db.setFileSynced(fileRow.id, {
          mtime: stat.mtimeMs,
          size: stat.size,
          contentHash: sha1(nextContent),
        });
      }
    });
    this.syncFile({ scope, path: filePath, workspaceKey: key, sessionId, force: true, trustedHeadings: new Set([newKey]) });
    return {
      scope,
      heading: nextSection.heading,
      previousHeading: oldSection.heading,
      renamed: newKey !== oldKey,
      replaced: true,
      unchanged: false,
      filePath,
    };
  }

  compactScope({ scope, workspaceDir, sessionId, entries }) {
    if (!Array.isArray(entries)) throw new MemoryError('INVALID_ARGUMENT', 'entries must be an array');
    if (entries.length > 100) throw new MemoryError('INVALID_ARGUMENT', 'at most 100 entries can be compacted at once');
    const filePath = this.pathForScope(scope, { workspaceDir, sessionId });
    const key = workspaceDir ? workspaceKey(workspaceDir) : '';
    const existingContent = readTextOrNull(filePath);
    const parsed = existingContent === null
      ? { sections: [], preamble: '', error: null }
      : parseMemoryMarkdown(existingContent);
    if (parsed.error !== null) throw new MemoryError('FILE_INVALID', parsed.error);

    const seen = new Set();
    const normalized = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') throw new MemoryError('INVALID_ARGUMENT', 'each entry must be an object');
      const heading = String(entry.heading ?? '').trim();
      const headingKey = normalizeHeading(heading);
      const body = String(entry.text ?? '').trim();
      if (heading === '' || headingKey === '') throw new MemoryError('INVALID_HEADING', 'each entry needs a heading');
      if (body === '') throw new MemoryError('INVALID_ARGUMENT', `entry "${heading}" needs text`);
      if (seen.has(headingKey)) throw new MemoryError('CONFLICT', `duplicate heading "${heading}" in compaction`);
      seen.add(headingKey);
      normalized.push({ heading, headingKey, body, hint: entry.hint, tags: entry.tags, confidence: entry.confidence });
    }

    const fileRow = this.db.ensureFile({ scope, path: filePath, workspaceKey: key, sessionId });
    const existing = this.db.listSectionsForFile(fileRow.id);
    const byKey = new Map(existing.map((row) => [row.headingKey, row]));
    const preamble = parsed.preamble.trim() === ''
      ? `# DSH Memory${scope === 'global' ? '' : ` — ${scope}`}`
      : parsed.preamble.trimEnd();
    const blocks = normalized.map((entry) => {
      const current = byKey.get(entry.headingKey);
      const hint = entry.hint === undefined ? (current?.hint ?? '') : String(entry.hint);
      return renderSection({ heading: entry.heading, hint, body: entry.body }).trimEnd();
    });
    const content = `${preamble}\n\n${blocks.join('\n\n')}${blocks.length === 0 ? '' : '\n'}`;
    const parsedNext = parseMemoryMarkdown(content);
    if (parsedNext.error !== null) throw new MemoryError('FILE_INVALID', parsedNext.error);
    atomicWriteText(filePath, content);
    const stat = statOrNull(filePath);
    const now = Date.now();
    let added = 0;
    let removed = 0;

    this.db.transaction(() => {
      for (const entry of normalized) {
        const current = byKey.get(entry.headingKey);
        const nextSection = findSection(parsedNext, entry.headingKey);
        if (!nextSection) throw new MemoryError('INDEX_FAILED', `compaction lost "${entry.heading}"`);
        if (current) {
          this.db.updateSection(current.id, {
            heading: nextSection.heading,
            headingKey: nextSection.headingKey,
            hint: nextSection.hint,
            body: nextSection.body,
            bodyHash: nextSection.bodyHash,
            lineStart: nextSection.startLine,
            lineEnd: nextSection.endLine,
            status: 0,
            reason: '',
          });
          this.db.updateMeta(current.id, {
            tags: entry.tags ?? current.tags,
            confidence: entry.confidence ?? current.confidence,
            sourceSessionId: sessionId ?? current.sourceSessionId,
            createdAt: current.createdAt || now,
            updatedAt: now,
          });
        } else {
          added += 1;
          this.db.insertSection({
            fileId: fileRow.id,
            heading: nextSection.heading,
            headingKey: nextSection.headingKey,
            hint: nextSection.hint,
            body: nextSection.body,
            bodyHash: nextSection.bodyHash,
            lineStart: nextSection.startLine,
            lineEnd: nextSection.endLine,
            status: 0,
            reason: '',
            tags: entry.tags ?? [],
            confidence: entry.confidence ?? 0.8,
            sourceSessionId: sessionId,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      for (const current of existing) {
        if (seen.has(current.headingKey)) continue;
        removed += 1;
        if (current.bodyHash !== '') {
          this.db.insertTombstone({ scope, headingKey: current.headingKey, bodyHash: current.bodyHash });
        }
        this.db.deleteSectionRow(current.id);
      }
      if (stat) {
        this.db.setFileSynced(fileRow.id, {
          mtime: stat.mtimeMs,
          size: stat.size,
          contentHash: sha1(content),
        });
      }
    });

    return { scope, kept: normalized.length, added, removed };
  }

  syncBeforeQuery({ workspaceDir, sessionId }) {    this.syncContext({ workspaceDir, sessionId });
  }

  readSection({ scope = 'auto', heading, workspaceDir, sessionId }) {
    this.syncBeforeQuery({ workspaceDir, sessionId });
    const headingKey = normalizeHeading(heading);
    if (headingKey === '') return null;
    const rows = this.db.readRows({
      headingKey,
      scope,
      workspaceKey: workspaceDir ? workspaceKey(workspaceDir) : '',
      sessionId,
    });
    return rows[0] ?? null;
  }

  search({ query, scope = 'all', workspaceDir, sessionId, limit = 8 }) {
    this.syncBeforeQuery({ workspaceDir, sessionId });
    return this.db.searchRows({
      query,
      scope,
      workspaceKey: workspaceDir ? workspaceKey(workspaceDir) : '',
      sessionId,
      limit,
    }).map((row) => ({ ...row, snippet: snippetFor(row, query) }));
  }

  list({ scope = 'all', workspaceDir, sessionId, limit = 30 }) {
    this.syncBeforeQuery({ workspaceDir, sessionId });
    return this.db.listRows({
      scope,
      workspaceKey: workspaceDir ? workspaceKey(workspaceDir) : '',
      sessionId,
      limit,
    });
  }

  forget({ scope, heading, workspaceDir, sessionId, confirm }) {
    if (confirm !== true) throw new MemoryError('CONFIRM_REQUIRED', 'confirm must be true to forget a memory');
    const filePath = this.pathForScope(scope, { workspaceDir, sessionId });
    const headingKey = normalizeHeading(heading);
    const content = readTextOrNull(filePath);
    const parsed = content === null ? { sections: [], error: null } : parseMemoryMarkdown(content);
    if (parsed.error !== null) throw new MemoryError('FILE_INVALID', parsed.error);
    const parsedSection = findSection(parsed, headingKey);
    const fileRow = this.db.getFileByPath(filePath);
    const row = fileRow ? this.db.sectionByHeading(fileRow.id, headingKey) : null;
    if (!parsedSection && !row) throw new MemoryError('NOT_FOUND', `no memory "${heading}" in ${scope}`);

    if (parsedSection) {
      atomicWriteText(filePath, removeSectionFromContent(content, parsedSection));
    }
    if (fileRow && row) {
      this.db.transaction(() => {
        this.db.insertTombstone({ scope, headingKey, bodyHash: row.bodyHash });
        this.db.deleteSectionRow(row.id);
      });
    }
    if (content !== null) {
      this.syncFile({
        scope,
        path: filePath,
        workspaceKey: workspaceDir ? workspaceKey(workspaceDir) : '',
        sessionId,
        force: true,
      });
    }
    return { scope, heading };
  }

  parsedForFile(filePath) {
    const content = readTextOrNull(filePath);
    if (content === null) return { content: null, parsed: null };
    const parsed = parseMemoryMarkdown(content);
    return { content, parsed: parsed.error === null ? parsed : null, error: parsed.error };
  }

  listAnomalies({ workspaceDir, sessionId } = {}) {
    this.syncContext({ workspaceDir, sessionId });
    const key = workspaceDir ? workspaceKey(workspaceDir) : '';
    const anomalies = [];
    const cache = new Map();
    const currentFor = (filePath, headingKey) => {
      if (!cache.has(filePath)) {
        const { parsed } = this.parsedForFile(filePath);
        cache.set(filePath, parsed);
      }
      const parsed = cache.get(filePath);
      return parsed ? findSection(parsed, headingKey) ?? null : null;
    };

    const sections = this.db.anomalySections({ workspaceKey: key, sessionId });
    const removed = sections.filter((row) => row.reason === 'removed');
    const added = sections.filter((row) => row.reason === 'added');

    const removedGroups = new Map();
    for (const row of removed) {
      const groupKey = `${row.fileId}:${row.bodyHash}`;
      const group = removedGroups.get(groupKey) ?? [];
      group.push(row);
      removedGroups.set(groupKey, group);
    }
    const addedGroups = new Map();
    for (const row of added) {
      const current = currentFor(row.path, row.headingKey);
      if (!current) continue;
      const groupKey = `${row.fileId}:${current.bodyHash}`;
      const group = addedGroups.get(groupKey) ?? [];
      group.push({ row, current });
      addedGroups.set(groupKey, group);
    }
    const pairedRemoved = new Set();
    const pairedAdded = new Set();
    for (const [groupKey, olds] of removedGroups) {
      const news = addedGroups.get(groupKey);
      if (olds.length !== 1 || !news || news.length !== 1) continue;
      const oldRow = olds[0];
      const { row: newRow, current } = news[0];
      pairedRemoved.add(oldRow.id);
      pairedAdded.add(newRow.id);
      anomalies.push({
        kind: 'section',
        scope: oldRow.scope,
        heading: newRow.heading,
        oldHeading: oldRow.heading,
        fromHeading: oldRow.heading,
        reason: 'renamed',
        old: oldRow.body,
        new: current.body,
        hint: current.hint,
        path: oldRow.path,
        tags: oldRow.tags,
        confidence: oldRow.confidence,
      });
    }

    for (const row of sections) {
      if (pairedRemoved.has(row.id) || pairedAdded.has(row.id)) continue;
      const current = currentFor(row.path, row.headingKey);
      anomalies.push({
        kind: 'section',
        scope: row.scope,
        heading: row.heading,
        reason: row.reason || 'modified',
        old: row.body,
        new: current ? current.body : null,
        hint: current ? current.hint : row.hint,
        path: row.path,
        tags: row.tags,
        confidence: row.confidence,
      });
    }
    for (const row of this.db.anomalyFiles({ workspaceKey: key, sessionId })) {
      anomalies.push({
        kind: 'file',
        scope: row.scope,
        heading: '',
        reason: 'parse-error',
        path: row.path,
        error: row.error ?? 'parse error',
        old: '',
        new: null,
      });
    }
    return anomalies;
  }

  approveAnomaly({ scope, heading, fromHeading, workspaceDir, sessionId }) {
    const filePath = this.pathForScope(scope, { workspaceDir, sessionId });
    const headingKey = normalizeHeading(heading);
    const { content, parsed, error } = this.parsedForFile(filePath);
    if (error) throw new MemoryError('FILE_INVALID', error);
    if (!parsed) throw new MemoryError('NOT_FOUND', 'memory file is missing');
    const fileRow = this.db.getFileByPath(filePath);
    if (!fileRow) throw new MemoryError('NOT_FOUND', 'memory file is not indexed');

    if (fromHeading !== undefined) {
      const oldKey = normalizeHeading(fromHeading);
      const oldRow = this.db.sectionByHeading(fileRow.id, oldKey);
      if (!oldRow) throw new MemoryError('NOT_FOUND', `no memory "${fromHeading}" in ${scope}`);
      const current = findSection(parsed, headingKey);
      if (!current) throw new MemoryError('NOT_FOUND', `no current section for "${heading}"`);
      const newRow = this.db.sectionByHeading(fileRow.id, headingKey);
      const stat = statOrNull(filePath);
      this.db.transaction(() => {
        if (newRow && newRow.id !== oldRow.id) this.db.deleteSectionRow(newRow.id);
        this.db.updateSection(oldRow.id, {
          heading: current.heading,
          headingKey,
          hint: current.hint,
          body: current.body,
          bodyHash: current.bodyHash,
          lineStart: current.startLine,
          lineEnd: current.endLine,
          status: 0,
          reason: '',
        });
        this.db.updateMeta(oldRow.id, { updatedAt: Date.now() });
        if (stat) {
          this.db.setFileSynced(fileRow.id, {
            mtime: stat.mtimeMs,
            size: stat.size,
            contentHash: sha1(content ?? ''),
          });
        }
      });
      return { scope, heading, action: 'renamed' };
    }

    const row = this.db.sectionByHeading(fileRow.id, headingKey);
    if (!row) throw new MemoryError('NOT_FOUND', `no memory "${heading}" in ${scope}`);
    const current = findSection(parsed, headingKey);
    const stat = statOrNull(filePath);
    if (current) {
      this.db.transaction(() => {
        this.db.updateSection(row.id, {
          heading: current.heading,
          headingKey: current.headingKey,
          hint: current.hint,
          body: current.body,
          bodyHash: current.bodyHash,
          lineStart: current.startLine,
          lineEnd: current.endLine,
          status: 0,
          reason: '',
        });
        this.db.updateMeta(row.id, { updatedAt: Date.now() });
        if (stat) {
          this.db.setFileSynced(fileRow.id, {
            mtime: stat.mtimeMs,
            size: stat.size,
            contentHash: sha1(content ?? ''),
          });
        }
      });
      return { scope, heading, action: 'approved' };
    }
    if (row.reason === 'removed') {
      this.db.transaction(() => {
        this.db.insertTombstone({ scope, headingKey, bodyHash: row.bodyHash });
        this.db.deleteSectionRow(row.id);
        if (stat) {
          this.db.setFileSynced(fileRow.id, {
            mtime: stat.mtimeMs,
            size: stat.size,
            contentHash: sha1(content ?? ''),
          });
        }
      });
      return { scope, heading, action: 'removed' };
    }
    throw new MemoryError('NOT_FOUND', `no current section for "${heading}"`);
  }

  deleteAnomaly({ scope, heading, fromHeading, workspaceDir, sessionId }) {
    const filePath = this.pathForScope(scope, { workspaceDir, sessionId });
    const headingKey = normalizeHeading(heading);
    const oldKey = fromHeading === undefined ? null : normalizeHeading(fromHeading);
    const { content, parsed, error } = this.parsedForFile(filePath);
    if (error) throw new MemoryError('FILE_INVALID', error);
    if (content !== null) {
      const current = parsed ? findSection(parsed, headingKey) : null;
      if (current) atomicWriteText(filePath, removeSectionFromContent(content, current));
    }
    const fileRow = this.db.getFileByPath(filePath);
    const rows = [];
    if (fileRow) {
      const newRow = this.db.sectionByHeading(fileRow.id, headingKey);
      if (newRow) rows.push(newRow);
      if (oldKey !== null && oldKey !== headingKey) {
        const oldRow = this.db.sectionByHeading(fileRow.id, oldKey);
        if (oldRow) rows.push(oldRow);
      }
    }
    if (rows.length > 0) {
      this.db.transaction(() => {
        for (const row of rows) {
          if (row.bodyHash !== '') {
            this.db.insertTombstone({ scope, headingKey: row.headingKey, bodyHash: row.bodyHash });
          }
          this.db.deleteSectionRow(row.id);
        }
      });
    }
    if (content !== null) {
      this.syncFile({
        scope,
        path: filePath,
        workspaceKey: workspaceDir ? workspaceKey(workspaceDir) : '',
        sessionId,
        force: true,
      });
    }
    return { scope, heading, action: 'deleted' };
  }

  retryAnomaly({ scope, workspaceDir, sessionId }) {
    const filePath = this.pathForScope(scope, { workspaceDir, sessionId });
    const result = this.syncFile({
      scope,
      path: filePath,
      workspaceKey: workspaceDir ? workspaceKey(workspaceDir) : '',
      sessionId,
      force: true,
    });
    if (result.status === 'error') throw new MemoryError('FILE_INVALID', result.error);
    return result;
  }

  rebuildAnomaly({ scope, workspaceDir, sessionId }) {
    const filePath = this.pathForScope(scope, { workspaceDir, sessionId });
    const { content, parsed, error } = this.parsedForFile(filePath);
    if (error) throw new MemoryError('FILE_INVALID', error);
    if (content === null || parsed === null) throw new MemoryError('NOT_FOUND', 'memory file is missing');
    const key = workspaceDir ? workspaceKey(workspaceDir) : '';
    const stat = statOrNull(filePath);
    const now = Date.now();
    this.db.transaction(() => {
      const fileRow = this.db.ensureFile({ scope, path: filePath, workspaceKey: key, sessionId });
      this.db.deleteSectionsForFile(fileRow.id);
      for (const section of parsed.sections) {
        this.db.insertSection({
          fileId: fileRow.id,
          heading: section.heading,
          headingKey: section.headingKey,
          hint: section.hint,
          body: section.body,
          bodyHash: section.bodyHash,
          lineStart: section.startLine,
          lineEnd: section.endLine,
          status: 0,
          reason: '',
          tags: [],
          confidence: 0.8,
          sourceSessionId: sessionId,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (stat) {
        this.db.setFileSynced(fileRow.id, {
          mtime: stat.mtimeMs,
          size: stat.size,
          contentHash: sha1(content),
        });
      }
    });
    return { scope, action: 'rebuilt', count: parsed.sections.length };
  }

  renderForAgent({ workspaceDir, sessionId, config }) {
    this.syncContext({ workspaceDir, sessionId });
    const rows = this.db.activeRows({
      workspaceKey: workspaceDir ? workspaceKey(workspaceDir) : '',
      sessionId,
    });
    return planInjection(rows, config);
  }

  renderVerbosityForAgent({ workspaceDir, config }) {
    return renderVerbosity(config);
  }
}
