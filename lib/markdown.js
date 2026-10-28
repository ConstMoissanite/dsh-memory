import { collapseWhitespace, normalizeHeading, sha1 } from './util.js';

const H2_RE = /^##\s+(.*)$/;

export function bodyHash(body) {
  return sha1(collapseWhitespace(body));
}

function splitLines(content) {
  return String(content ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
}

function trimBlankStart(lines) {
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  return lines;
}

function trimBlankEnd(lines) {
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

function extractHint(lines) {
  let index = 0;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  if (index >= lines.length || !/^\s*>/.test(lines[index])) {
    return { hint: '', bodyLines: lines };
  }
  const hintLines = [];
  while (index < lines.length && /^\s*>/.test(lines[index])) {
    hintLines.push(lines[index].replace(/^\s*>\s?/, ''));
    index += 1;
  }
  let hint = collapseWhitespace(hintLines.join(' '));
  if (/^use when\s*:/i.test(hint)) hint = hint.replace(/^use when\s*:\s*/i, '').trim();
  while (index < lines.length && lines[index].trim() === '') index += 1;
  return { hint, bodyLines: lines.slice(index) };
}

function finalizeSection(raw, endLine) {
  const { hint, bodyLines } = extractHint(raw.lines);
  const body = bodyLines.join('\n').trim();
  return {
    heading: raw.heading,
    headingKey: normalizeHeading(raw.heading),
    hint,
    body,
    bodyHash: bodyHash(body),
    startLine: raw.startLine,
    endLine,
    headingLine: raw.startLine,
  };
}

/**
 * Parse a MEMORY.md file. `##` headings are entries; a leading blockquote
 * inside an entry is its retrieval hint (`> Use when: ...`). Anything before
 * the first `##` is the file preamble and is preserved on edits.
 */
export function parseMemoryMarkdown(content) {
  const lines = splitLines(content);
  const sections = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = H2_RE.exec(lines[index]);
    if (match) {
      if (current !== null) sections.push(finalizeSection(current, index));
      const heading = match[1].trim().replace(/\s+#+\s*$/, '');
      if (heading === '') return { sections: [], preamble: '', error: `line ${index + 1}: empty heading` };
      current = { heading, startLine: index, lines: [] };
    } else if (current !== null) {
      current.lines.push(lines[index]);
    }
  }
  if (current !== null) sections.push(finalizeSection(current, lines.length));

  const seen = new Map();
  for (const section of sections) {
    if (section.headingKey === '') {
      return { sections: [], preamble: '', error: `line ${section.startLine + 1}: heading has no searchable text` };
    }
    if (seen.has(section.headingKey)) {
      return {
        sections: [],
        preamble: '',
        error: `duplicate heading "${section.heading}" at lines ${seen.get(section.headingKey) + 1} and ${section.startLine + 1}`,
      };
    }
    seen.set(section.headingKey, section.startLine);
  }

  const preamble = sections.length > 0 ? lines.slice(0, sections[0].startLine).join('\n') : lines.join('\n');
  return { sections, preamble, error: null };
}

export function findSection(parsed, headingKey) {
  return parsed.sections.find((section) => section.headingKey === headingKey);
}

export function renderSection(section) {
  const heading = String(section.heading ?? '').trim();
  const hint = String(section.hint ?? '')
    .replace(/^use when\s*:\s*/i, '')
    .replace(/^when\s+/i, '')
    .trim();
  const body = String(section.body ?? '').trim();
  const lines = [`## ${heading}`];
  if (hint !== '') lines.push(`> Use when: ${hint}`);
  if (body !== '') {
    lines.push('');
    lines.push(body);
  }
  lines.push('');
  return lines.join('\n');
}

export function replaceSectionInContent(content, target, nextSection) {
  const lines = splitLines(content);
  const before = trimBlankEnd(lines.slice(0, target.startLine));
  const after = trimBlankStart(lines.slice(target.endLine));
  const replacement = trimBlankEnd(splitLines(renderSection(nextSection)));
  const merged = [...before];
  if (merged.length > 0) merged.push('');
  merged.push(...replacement);
  if (after.length > 0) merged.push('', ...after);
  return `${trimBlankEnd(merged).join('\n')}\n`;
}

export function appendSectionToContent(content, nextSection) {
  const base = String(content ?? '').replace(/\s+$/, '');
  const block = renderSection(nextSection).trimEnd();
  return `${base === '' ? '' : `${base}\n\n`}${block}\n`;
}

export function removeSectionFromContent(content, target) {
  const lines = splitLines(content);
  const before = trimBlankEnd(lines.slice(0, target.startLine));
  const after = trimBlankStart(lines.slice(target.endLine));
  const merged = [...before];
  if (merged.length > 0 && after.length > 0) merged.push('');
  merged.push(...after);
  const text = trimBlankEnd(merged).join('\n');
  return text === '' ? '' : `${text}\n`;
}

export function fileHeader(scope) {
  if (scope === 'global') return '# DSH Memory\n\n';
  return `# DSH Memory — ${scope}\n\n`;
}
