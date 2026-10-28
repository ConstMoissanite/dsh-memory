import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ftsQuery, tokenizeForSearch } from './util.js';

export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'workspace', 'session')),
  path TEXT NOT NULL UNIQUE,
  workspace_key TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  mtime REAL NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0, 1)),
  error TEXT,
  indexed_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  heading TEXT NOT NULL,
  heading_key TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  body_hash TEXT NOT NULL DEFAULT '',
  line_start INTEGER NOT NULL DEFAULT 0,
  line_end INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0, 1)),
  reason TEXT NOT NULL DEFAULT '',
  UNIQUE (file_id, heading_key)
);

CREATE TABLE IF NOT EXISTS section_meta (
  section_id INTEGER PRIMARY KEY REFERENCES sections(id) ON DELETE CASCADE,
  tags TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.8,
  always_full INTEGER NOT NULL DEFAULT 0,
  source_session_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tombstones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  heading_key TEXT NOT NULL,
  body_hash TEXT NOT NULL DEFAULT '',
  deleted_at INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
  search_text,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS sections_fts_delete AFTER DELETE ON sections BEGIN
  DELETE FROM sections_fts WHERE rowid = old.id;
END;

CREATE INDEX IF NOT EXISTS idx_files_scope ON files(scope);
CREATE INDEX IF NOT EXISTS idx_files_workspace ON files(workspace_key);
CREATE INDEX IF NOT EXISTS idx_sections_file ON sections(file_id);
CREATE INDEX IF NOT EXISTS idx_sections_status ON sections(status);
`;

function parseTags(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function mapSection(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    fileId: Number(row.file_id),
    scope: row.scope,
    path: row.path,
    heading: row.heading,
    headingKey: row.heading_key,
    hint: row.hint ?? '',
    body: row.body ?? '',
    bodyHash: row.body_hash ?? '',
    status: Number(row.status ?? 0),
    reason: row.reason ?? '',
    lineStart: Number(row.line_start ?? 0),
    lineEnd: Number(row.line_end ?? 0),
    tags: parseTags(row.tags),
    confidence: Number(row.confidence ?? 0.8),
    alwaysFull: Number(row.always_full ?? 0) === 1,
    sourceSessionId: row.source_session_id ?? '',
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    rank: row.rank === undefined ? undefined : Number(row.rank),
  };
}

function scopeClause(scope, { workspaceKey = '', sessionId = '' } = {}) {
  if (scope === 'global') return { sql: "f.scope = 'global'", params: [] };
  if (scope === 'workspace') return { sql: "f.scope = 'workspace' AND f.workspace_key = ?", params: [workspaceKey] };
  if (scope === 'session') return { sql: "f.scope = 'session' AND f.session_id = ?", params: [sessionId] };
  return {
    sql: "(f.scope = 'global' OR (f.scope = 'workspace' AND f.workspace_key = ?) OR (f.scope = 'session' AND f.session_id = ?))",
    params: [workspaceKey, sessionId],
  };
}

function searchTextFor({ heading, hint, body, tags }) {
  return tokenizeForSearch([heading, hint, body, (tags ?? []).join(' ')].join('\n')).join(' ');
}

export class MemoryDb {
  #db;
  #stmts = new Map();

  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('PRAGMA busy_timeout = 3000');
    this.#migrate();
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // POSIX-only hygiene.
    }
  }

  #migrate() {
    const row = this.#db.prepare('PRAGMA user_version').get();
    const version = Number(row?.user_version ?? 0);
    if (version !== SCHEMA_VERSION) {
      this.#db.exec('DROP TRIGGER IF EXISTS sections_fts_delete');
      this.#db.exec('DROP TABLE IF EXISTS sections_fts');
      this.#db.exec('DROP TABLE IF EXISTS sections');
      this.#db.exec('DROP TABLE IF EXISTS section_meta');
      this.#db.exec('DROP TABLE IF EXISTS files');
      this.#db.exec('DROP TABLE IF EXISTS tombstones');
      this.#db.exec(SCHEMA_SQL);
      this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else {
      this.#db.exec(SCHEMA_SQL);
    }
  }

  #stmt(sql) {
    let statement = this.#stmts.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#stmts.set(sql, statement);
    }
    return statement;
  }

  transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Keep the original failure.
      }
      throw error;
    }
  }

  close() {
    for (const statement of this.#stmts.values()) {
      try {
        statement.finalize?.();
      } catch {
        // Best effort.
      }
    }
    this.#stmts.clear();
    try {
      this.#db.close();
    } catch {
      // Already closed.
    }
  }

  getFileByPath(filePath) {
    return this.#stmt('SELECT * FROM files WHERE path = ?').get(filePath) ?? null;
  }

  getFileById(id) {
    return this.#stmt('SELECT * FROM files WHERE id = ?').get(Number(id)) ?? null;
  }

  ensureFile({ scope, path: filePath, workspaceKey = '', sessionId = '' }) {
    this.#stmt(`
      INSERT INTO files (scope, path, workspace_key, session_id, status, indexed_at)
      VALUES (?, ?, ?, ?, 0, ?)
      ON CONFLICT(path) DO UPDATE SET
        scope = excluded.scope,
        workspace_key = excluded.workspace_key,
        session_id = excluded.session_id
    `).run(scope, filePath, workspaceKey, sessionId, Date.now());
    return this.getFileByPath(filePath);
  }

  setFileSynced(id, { mtime, size, contentHash }) {
    this.#stmt(`
      UPDATE files
      SET mtime = ?, size = ?, content_hash = ?, status = 0, error = NULL, indexed_at = ?
      WHERE id = ?
    `).run(Number(mtime ?? 0), Number(size ?? 0), String(contentHash ?? ''), Date.now(), Number(id));
  }

  setFileError(id, { mtime, size, error }) {
    this.#stmt(`
      UPDATE files
      SET mtime = ?, size = ?, status = 1, error = ?, indexed_at = ?
      WHERE id = ?
    `).run(Number(mtime ?? 0), Number(size ?? 0), String(error ?? 'parse error'), Date.now(), Number(id));
  }

  deleteFile(id) {
    this.#stmt('DELETE FROM files WHERE id = ?').run(Number(id));
  }

  fileRowsForContext({ workspaceKey = '', sessionId = '' } = {}) {
    return this.#stmt(`
      SELECT * FROM files
      WHERE scope = 'global'
        OR (scope = 'workspace' AND workspace_key = ?)
        OR (scope = 'session' AND session_id = ?)
      ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'workspace' THEN 1 ELSE 2 END
    `).all(workspaceKey, sessionId);
  }

  listSectionsForFile(fileId) {
    return this.#stmt(`
      SELECT s.*, m.tags, m.confidence, m.always_full, m.source_session_id, m.created_at, m.updated_at
      FROM sections s
      LEFT JOIN section_meta m ON m.section_id = s.id
      WHERE s.file_id = ?
      ORDER BY s.id
    `).all(Number(fileId)).map(mapSection);
  }

  sectionByHeading(fileId, headingKey) {
    return mapSection(this.#stmt(`
      SELECT s.*, m.tags, m.confidence, m.always_full, m.source_session_id, m.created_at, m.updated_at
      FROM sections s
      LEFT JOIN section_meta m ON m.section_id = s.id
      WHERE s.file_id = ? AND s.heading_key = ?
    `).get(Number(fileId), headingKey));
  }

  sectionById(id) {
    return mapSection(this.#stmt(`
      SELECT s.*, m.tags, m.confidence, m.always_full, m.source_session_id, m.created_at, m.updated_at
      FROM sections s
      LEFT JOIN section_meta m ON m.section_id = s.id
      WHERE s.id = ?
    `).get(Number(id)));
  }

  insertSection(section) {
    const result = this.#stmt(`
      INSERT INTO sections
        (file_id, heading, heading_key, hint, body, body_hash, line_start, line_end, status, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(section.fileId),
      section.heading,
      section.headingKey,
      section.hint ?? '',
      section.body ?? '',
      section.bodyHash ?? '',
      Number(section.lineStart ?? 0),
      Number(section.lineEnd ?? 0),
      Number(section.status ?? 0),
      section.reason ?? '',
    );
    const id = Number(result.lastInsertRowid);
    const now = Date.now();
    this.#stmt(`
      INSERT OR IGNORE INTO section_meta
        (section_id, tags, confidence, always_full, source_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      JSON.stringify(section.tags ?? []),
      Number(section.confidence ?? 0.8),
      section.alwaysFull === true ? 1 : 0,
      section.sourceSessionId ?? '',
      Number(section.createdAt ?? now),
      Number(section.updatedAt ?? now),
    );
    this.replaceFts(id, searchTextFor(section));
    return id;
  }

  updateSection(id, patch) {
    const current = this.sectionById(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.#stmt(`
      UPDATE sections
      SET heading = ?, heading_key = ?, hint = ?, body = ?, body_hash = ?,
          line_start = ?, line_end = ?, status = ?, reason = ?
      WHERE id = ?
    `).run(
      next.heading,
      next.headingKey,
      next.hint ?? '',
      next.body ?? '',
      next.bodyHash ?? '',
      Number(next.lineStart ?? 0),
      Number(next.lineEnd ?? 0),
      Number(next.status ?? 0),
      next.reason ?? '',
      Number(id),
    );
    this.replaceFts(Number(id), searchTextFor(next));
    return this.sectionById(id);
  }

  updateMeta(sectionId, patch) {
    const current = this.metaFor(sectionId) ?? {
      tags: [],
      confidence: 0.8,
      alwaysFull: false,
      sourceSessionId: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const next = { ...current, ...patch, updatedAt: patch?.updatedAt ?? Date.now() };
    this.#stmt(`
      INSERT INTO section_meta
        (section_id, tags, confidence, always_full, source_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(section_id) DO UPDATE SET
        tags = excluded.tags,
        confidence = excluded.confidence,
        always_full = excluded.always_full,
        source_session_id = excluded.source_session_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      Number(sectionId),
      JSON.stringify(next.tags ?? []),
      Number(next.confidence ?? 0.8),
      next.alwaysFull === true ? 1 : 0,
      next.sourceSessionId ?? '',
      Number(next.createdAt ?? Date.now()),
      Number(next.updatedAt ?? Date.now()),
    );
    return this.metaFor(sectionId);
  }

  metaFor(sectionId) {
    const row = this.#stmt('SELECT * FROM section_meta WHERE section_id = ?').get(Number(sectionId));
    if (!row) return null;
    return {
      tags: parseTags(row.tags),
      confidence: Number(row.confidence ?? 0.8),
      alwaysFull: Number(row.always_full ?? 0) === 1,
      sourceSessionId: row.source_session_id ?? '',
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  replaceFts(sectionId, searchText) {
    const id = Number(sectionId);
    this.#stmt('DELETE FROM sections_fts WHERE rowid = ?').run(id);
    this.#stmt('INSERT INTO sections_fts (rowid, search_text) VALUES (?, ?)').run(id, String(searchText ?? ''));
  }

  deleteSectionRow(sectionId) {
    this.#stmt('DELETE FROM sections WHERE id = ?').run(Number(sectionId));
  }

  deleteSectionsForFile(fileId) {
    this.#stmt('DELETE FROM sections WHERE file_id = ?').run(Number(fileId));
  }

  insertTombstone({ scope, headingKey, bodyHash: hash, deletedAt = Date.now() }) {
    this.#stmt(`
      INSERT INTO tombstones (scope, heading_key, body_hash, deleted_at)
      VALUES (?, ?, ?, ?)
    `).run(scope, headingKey, hash ?? '', Number(deletedAt));
  }

  activeRows({ workspaceKey = '', sessionId = '' } = {}) {
    return this.#stmt(`
      SELECT s.id, s.heading, s.heading_key, s.hint, s.body, s.body_hash, s.status, s.reason,
             m.tags, m.confidence, m.always_full, m.source_session_id, m.created_at, m.updated_at,
             f.scope, f.path
      FROM sections s
      JOIN files f ON f.id = s.file_id
      JOIN section_meta m ON m.section_id = s.id
      WHERE s.status = 0 AND f.status = 0
        AND (f.scope = 'global'
          OR (f.scope = 'workspace' AND f.workspace_key = ?)
          OR (f.scope = 'session' AND f.session_id = ?))
      ORDER BY s.id
    `).all(workspaceKey, sessionId).map(mapSection);
  }

  searchRows({ query, scope = 'all', workspaceKey = '', sessionId = '', limit = 8 }) {
    const match = ftsQuery(query);
    if (match === '') return [];
    const clause = scopeClause(scope, { workspaceKey, sessionId });
    return this.#stmt(`
      SELECT s.id, s.heading, s.heading_key, s.hint, s.body, s.body_hash, s.status, s.reason,
             m.tags, m.confidence, m.always_full, m.source_session_id, m.created_at, m.updated_at,
             f.scope, f.path, bm25(sections_fts) AS rank
      FROM sections_fts
      JOIN sections s ON s.id = sections_fts.rowid
      JOIN files f ON f.id = s.file_id
      JOIN section_meta m ON m.section_id = s.id
      WHERE sections_fts MATCH ?
        AND s.status = 0 AND f.status = 0
        AND ${clause.sql}
      ORDER BY rank ASC, s.id ASC
      LIMIT ?
    `).all(match, ...clause.params, Number(limit)).map(mapSection);
  }

  listRows({ scope = 'all', workspaceKey = '', sessionId = '', limit = 30 }) {
    const clause = scopeClause(scope, { workspaceKey, sessionId });
    return this.#stmt(`
      SELECT s.id, s.heading, s.heading_key, s.hint, s.body, s.body_hash, s.status, s.reason,
             m.tags, m.confidence, m.always_full, m.source_session_id, m.created_at, m.updated_at,
             f.scope, f.path
      FROM sections s
      JOIN files f ON f.id = s.file_id
      JOIN section_meta m ON m.section_id = s.id
      WHERE s.status = 0 AND f.status = 0
        AND ${clause.sql}
      ORDER BY CASE f.scope WHEN 'session' THEN 0 WHEN 'workspace' THEN 1 ELSE 2 END,
               m.confidence DESC, m.updated_at DESC, s.heading COLLATE NOCASE
      LIMIT ?
    `).all(...clause.params, Number(limit)).map(mapSection);
  }

  readRows({ headingKey, scope = 'auto', workspaceKey = '', sessionId = '' }) {
    const clause = scopeClause(scope, { workspaceKey, sessionId });
    return this.#stmt(`
      SELECT s.id, s.heading, s.heading_key, s.hint, s.body, s.body_hash, s.status, s.reason,
             m.tags, m.confidence, m.always_full, m.source_session_id, m.created_at, m.updated_at,
             f.scope, f.path
      FROM sections s
      JOIN files f ON f.id = s.file_id
      JOIN section_meta m ON m.section_id = s.id
      WHERE s.heading_key = ? AND s.status = 0 AND f.status = 0
        AND ${clause.sql}
      ORDER BY CASE f.scope WHEN 'session' THEN 0 WHEN 'workspace' THEN 1 ELSE 2 END
      LIMIT 1
    `).all(headingKey, ...clause.params).map(mapSection);
  }

  anomalySections({ workspaceKey = '', sessionId = '' } = {}) {
    return this.#stmt(`
      SELECT s.id, s.heading, s.heading_key, s.hint, s.body, s.body_hash, s.status, s.reason,
             s.file_id, s.line_start, s.line_end,
             m.tags, m.confidence, m.always_full, m.source_session_id, m.created_at, m.updated_at,
             f.scope, f.path
      FROM sections s
      JOIN files f ON f.id = s.file_id
      JOIN section_meta m ON m.section_id = s.id
      WHERE s.status = 1 AND f.status = 0
        AND (f.scope = 'global'
          OR (f.scope = 'workspace' AND f.workspace_key = ?)
          OR (f.scope = 'session' AND f.session_id = ?))
      ORDER BY CASE f.scope WHEN 'session' THEN 0 WHEN 'workspace' THEN 1 ELSE 2 END, s.id
    `).all(workspaceKey, sessionId).map(mapSection);
  }

  anomalyFiles({ workspaceKey = '', sessionId = '' } = {}) {
    return this.#stmt(`
      SELECT * FROM files
      WHERE status = 1
        AND (scope = 'global'
          OR (scope = 'workspace' AND workspace_key = ?)
          OR (scope = 'session' AND session_id = ?))
      ORDER BY CASE scope WHEN 'session' THEN 0 WHEN 'workspace' THEN 1 ELSE 2 END
    `).all(workspaceKey, sessionId);
  }

  countActive({ workspaceKey = '', sessionId = '' } = {}) {
    const row = this.#stmt(`
      SELECT COUNT(*) AS count
      FROM sections s
      JOIN files f ON f.id = s.file_id
      WHERE s.status = 0 AND f.status = 0
        AND (f.scope = 'global'
          OR (f.scope = 'workspace' AND f.workspace_key = ?)
          OR (f.scope = 'session' AND f.session_id = ?))
    `).get(workspaceKey, sessionId);
    return Number(row?.count ?? 0);
  }

  countTombstones() {
    const row = this.#stmt('SELECT COUNT(*) AS count FROM tombstones').get();
    return Number(row?.count ?? 0);
  }
}
