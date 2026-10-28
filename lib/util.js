import { createHash } from 'node:crypto';
import path from 'node:path';

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sha1(value) {
  return createHash('sha1').update(String(value ?? ''), 'utf8').digest('hex');
}

export function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeHeading(value) {
  return collapseWhitespace(String(value ?? '').normalize('NFKC')).toLowerCase();
}

export function normalizeWorkspaceDir(dir) {
  const raw = path.resolve(String(dir ?? '.')).replace(/\\/g, '/');
  const trimmed = raw.replace(/\/+$/, '');
  const resolved = trimmed === '' ? '/' : trimmed;
  if (/^[a-zA-Z]:\//.test(resolved) || /^\/\//.test(resolved)) return resolved.toLowerCase();
  return resolved;
}

export function workspaceKey(dir) {
  return sha1(normalizeWorkspaceDir(dir));
}

export function safeSegment(value) {
  const text = String(value ?? '').trim();
  if (/^[A-Za-z0-9._-]{1,128}$/.test(text)) return text;
  return `h-${sha1(text).slice(0, 32)}`;
}

export function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function truncateText(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

const LATIN_RE = /[a-z0-9][a-z0-9_]*/g;
const HAN_RE = /\p{Script=Han}+/gu;
const HAS_HAN_RE = /\p{Script=Han}/u;

/**
 * Tokenize for the FTS5 `unicode61` index. Latin runs are kept as words;
 * CJK runs become unigrams plus bigrams because unicode61 does not segment
 * Han text. Query tokenization keeps bigrams (and single characters) so a
 * two-character Chinese query still matches.
 */
export function tokenizeForSearch(value, { query = false } = {}) {
  const text = String(value ?? '').normalize('NFKC').toLowerCase();
  const tokens = new Set();
  for (const match of text.matchAll(LATIN_RE)) {
    const token = match[0];
    if (token.length >= 2) tokens.add(token);
    for (const part of token.split('_')) if (part.length >= 2) tokens.add(part);
  }
  for (const match of text.matchAll(HAN_RE)) {
    const run = match[0];
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    if (!query) for (const char of run) tokens.add(char);
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return [...tokens];
}

export function ftsQuery(value) {
  const text = String(value ?? '');
  const tokens = tokenizeForSearch(text, { query: true });
  if (tokens.length === 0) return '';
  const quoted = tokens.map((token) => `"${token.replace(/"/g, '""')}"`);
  const hasHan = HAS_HAN_RE.test(text.normalize('NFKC'));
  const hasWhitespace = /\s/.test(text.trim());
  // Identifier-like Latin queries are exact; natural-language and CJK queries
  // stay recall-oriented and rely on BM25 ranking.
  return quoted.join(!hasHan && !hasWhitespace ? ' AND ' : ' OR ');
}

/** Prevent memory text from closing the prompt-owned `<memory>` frames. */
export function neutralizeTags(value) {
  return String(value ?? '').replace(/<(\/?(?:memory|memory-hints|system-reminder)\b)/gi, '&lt;$1');
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}
