import os from 'node:os';
import path from 'node:path';
import { MemoryDb } from './lib/db.js';
import { MemoryService, MemoryError } from './lib/service.js';
import { resolveConfig } from './lib/config.js';
import { databasePath } from './lib/files.js';

const TOOL_TEXT_MAX = 8000;
const TOOL_HINT_MAX = 500;
const TOOL_HEADING_MAX = 120;
const TOOL_TAGS_MAX = 8;
const TOOL_TAG_MAX = 32;
const BODY_LIMIT = 64 * 1024;

function resolveHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function withAgentContext(ctx, exec) {
  const session = exec?.agent?.session;
  const sessionId = typeof session?.id === 'string' ? session.id : '';
  let workspaceDir = typeof session?.header?.cwd === 'string' ? session.header.cwd : '';
  if (workspaceDir === '' && session) {
    try {
      workspaceDir = ctx.get('workingDirectory')?.get?.(session) ?? '';
    } catch {
      workspaceDir = '';
    }
  }
  if (workspaceDir === '') workspaceDir = process.cwd();
  return { sessionId, workspaceDir };
}

function defaultScope(config, info) {
  if (config.defaultScope === 'session' && info.sessionId === '') {
    return info.workspaceDir === '' ? 'global' : 'workspace';
  }
  if (config.defaultScope === 'workspace' && info.workspaceDir === '') return 'global';
  return config.defaultScope;
}

function fail(tool, code, message) {
  return { ok: false, text: `${tool}: ${code} — ${message}` };
}

function toolOutput(properties) {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'text'],
      properties: {
        ok: { type: 'boolean' },
        text: { type: 'string' },
        ...properties,
      },
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  };
}

function validateString(value, name, max) {
  if (typeof value !== 'string') throw new MemoryError('INVALID_ARGUMENT', `${name} must be a string`);
  const text = value.trim();
  if (text === '') throw new MemoryError('INVALID_ARGUMENT', `${name} must not be empty`);
  if (text.length > max) throw new MemoryError('INVALID_ARGUMENT', `${name} is longer than ${max} characters`);
  return text;
}

function validateHeading(value) {
  const heading = validateString(value, 'heading', TOOL_HEADING_MAX);
  if (heading.includes('\n') || heading.includes('\r')) {
    throw new MemoryError('INVALID_ARGUMENT', 'heading must be one line');
  }
  return heading;
}

function validateHint(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new MemoryError('INVALID_ARGUMENT', 'hint must be a string');
  const hint = value.trim();
  if (hint.length > TOOL_HINT_MAX) {
    throw new MemoryError('INVALID_ARGUMENT', `hint is longer than ${TOOL_HINT_MAX} characters`);
  }
  return hint;
}

function validateTags(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new MemoryError('INVALID_ARGUMENT', 'tags must be an array of strings');
  const tags = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw new MemoryError('INVALID_ARGUMENT', 'tags must be an array of strings');
    const tag = raw.trim().replace(/^#/, '').toLowerCase();
    if (tag === '') continue;
    if (tag.length > TOOL_TAG_MAX) {
      throw new MemoryError('INVALID_ARGUMENT', `each tag must be at most ${TOOL_TAG_MAX} characters`);
    }
    if (!tags.includes(tag)) tags.push(tag);
    if (tags.length > TOOL_TAGS_MAX) break;
  }
  return tags;
}

function validateScope(value, allowed) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new MemoryError('INVALID_ARGUMENT', `scope must be one of ${allowed.join(', ')}`);
  }
  return value;
}

function validateLimit(value, fallback, max) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new MemoryError('INVALID_ARGUMENT', 'limit must be a positive integer');
  }
  return Math.min(number, max);
}

function validateConfidence(value) {
  if (value === undefined || value === null) return 0.8;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new MemoryError('INVALID_ARGUMENT', 'confidence must be between 0 and 1');
  }
  return number;
}

function formatRead(row) {
  const tags = row.tags.length > 0 ? row.tags.join(', ') : 'none';
  return [
    `[${row.scope}] ${row.heading}`,
    '',
    row.body,
    '',
    `Hint: ${row.hint === '' ? '(none)' : row.hint}`,
    `Tags: ${tags}`,
    `Confidence: ${row.confidence}`,
  ].join('\n');
}

function formatSearch(rows) {
  if (rows.length === 0) return 'No matching memory.';
  const lines = rows.map((row) => `- [${row.scope}] ${row.heading} — ${row.snippet}`);
  lines.push('', 'Use memory_read(scope, heading) for the full entry.');
  return lines.join('\n');
}

function formatList(rows) {
  if (rows.length === 0) return 'No memory entries.';
  return rows.map((row) => {
    const hint = row.hint === '' ? '' : ` — ${row.hint}`;
    return `- [${row.scope}] ${row.heading}${hint}`;
  }).join('\n');
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      body += chunk;
      if (body.length > BODY_LIMIT) {
        settled = true;
        reject(new MemoryError('BODY_TOO_LARGE', 'request body is too large'));
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(body === '' ? {} : JSON.parse(body));
      } catch {
        reject(new MemoryError('BAD_JSON', 'request body is not valid JSON'));
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function writeJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

export function apply(ctx, rawConfig) {
  const homeDir = resolveHome();
  const config = resolveConfig({ homeDir, pluginConfig: rawConfig });
  if (config.enabled === false) return;

  const db = new MemoryDb(databasePath(homeDir));
  const service = new MemoryService({ homeDir, db, logger: ctx.logger });
  ctx.effect(() => () => db.close(), 'dsh-memory:close-db');

  const configFor = (workspaceDir) => resolveConfig({ homeDir, workspaceDir, pluginConfig: rawConfig });

  const attachAgent = (agent) => {
    if (!agent?.ctx || typeof agent.ctx.inject !== 'function') return;
    let cleanup = null;
    const onDispose = agent.ctx.inject(['systemPrompt'], (promptScope) => {
      const offMemory = promptScope.systemPrompt.section({
        name: 'dsh-memory:memory',
        order: 460,
        interpolate: false,
        text: () => {
          try {
            const info = withAgentContext(ctx, { agent });
            const effective = configFor(info.workspaceDir);
            if (!effective.enabled || !effective.autoInject) return '';
            return service.renderForAgent({ ...info, config: effective });
          } catch (error) {
            ctx.logger?.warn?.(`dsh-memory: memory section failed: ${String(error?.message ?? error)}`);
            return '';
          }
        },
      });
      const offVerbosity = promptScope.systemPrompt.section({
        name: 'dsh-memory:verbosity',
        order: 461,
        interpolate: false,
        text: () => {
          try {
            const info = withAgentContext(ctx, { agent });
            const effective = configFor(info.workspaceDir);
            if (!effective.enabled) return '';
            return service.renderVerbosityForAgent({ ...info, config: effective });
          } catch {
            return '';
          }
        },
      });
      cleanup = () => {
        try { offMemory(); } catch { /* Disposed. */ }
        try { offVerbosity(); } catch { /* Disposed. */ }
      };
      promptScope.effect(() => () => cleanup(), 'dsh-memory:sections');
    });
    if (typeof onDispose === 'function') {
      const previous = cleanup;
      cleanup = () => {
        try { previous?.(); } catch { /* Disposed. */ }
        try { onDispose(); } catch { /* Disposed. */ }
      };
    }
  };

  const syncAgent = (agent) => {
    try {
      service.syncContext(withAgentContext(ctx, { agent }));
    } catch (error) {
      ctx.logger?.warn?.(`dsh-memory: session sync failed: ${String(error?.message ?? error)}`);
    }
  };

  ctx.inject(['agents'], (scope) => {
    const attached = new Set();
    const attach = (agent) => {
      if (!agent || attached.has(agent)) return;
      attached.add(agent);
      attachAgent(agent);
    };
    for (const agent of scope.agents.list()) {
      syncAgent(agent);
      attach(agent);
    }
    scope.on('agent/created', ({ agent }) => {
      syncAgent(agent);
      attach(agent);
    });
  });

  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'memory_write',
      description: 'Store one durable memory. Global memories are injected in full every turn; workspace/session memories are indexed only as hints and are fetched with memory_read. Put the retrieval trigger (when this memory should be consulted) in hint, not a summary. A same-heading write with different text or hint returns CONFLICT unless replace is true. Set previousHeading to rename an existing entry in place; metadata is preserved, and omitted text/hint keep their current values.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['heading'],
        properties: {
          scope: { type: 'string', enum: ['global', 'workspace', 'session'], description: 'Storage scope. Defaults to the configured default scope (workspace). Global entries affect every workspace.' },
          heading: { type: 'string', description: 'Stable one-line topic heading. This is the override key and the name used by memory_read. For a rename, this is the new heading.' },
          previousHeading: { type: 'string', description: 'Existing heading to rename. When set, the entry is updated in place and its tags, confidence, and timestamps are preserved.' },
          text: { type: 'string', description: 'Durable body. Required for a new write; optional with previousHeading, where omitting it keeps the existing body.' },
          hint: { type: 'string', description: 'When this memory should be retrieved, written as a trigger condition. Workspace/session entries are visible only through this hint. Optional with previousHeading, where omitting it keeps the current hint.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase tags for search and filtering.' },
          confidence: { type: 'number', description: 'Confidence from 0 to 1. Defaults to 0.8.' },
          replace: { type: 'boolean', description: 'Only for a same-heading write without previousHeading. Set true when deliberately replacing an existing entry with different text or hint; otherwise such a write returns CONFLICT.' },
        },
      },
      output: toolOutput({
        scope: { type: 'string' },
        heading: { type: 'string' },
        previousHeading: { type: 'string' },
        renamed: { type: 'boolean' },
        replaced: { type: 'boolean' },
        unchanged: { type: 'boolean' },
      }),
      async execute(args, exec) {
        try {
          const info = withAgentContext(ctx, exec);
          const effective = configFor(info.workspaceDir);
          const requestedScope = validateScope(args.scope, ['global', 'workspace', 'session']);
          const storageScope = requestedScope ?? defaultScope(effective, info);
          const heading = validateHeading(args.heading);
          const previousHeading = args.previousHeading === undefined ? undefined : validateHeading(args.previousHeading);
          const text = args.text === undefined ? undefined : validateString(args.text, 'text', TOOL_TEXT_MAX);
          if (text === undefined && previousHeading === undefined) {
            throw new MemoryError('INVALID_ARGUMENT', 'text is required unless previousHeading is set');
          }
          const hint = args.hint === undefined ? undefined : validateHint(args.hint);
          const tags = validateTags(args.tags);
          const confidence = args.confidence === undefined ? undefined : validateConfidence(args.confidence);
          const result = previousHeading === undefined
            ? service.writeSection({
              scope: storageScope,
              workspaceDir: info.workspaceDir,
              sessionId: info.sessionId,
              heading,
              hint,
              text,
              tags,
              confidence,
              replace: args.replace === true,
            })
            : service.renameSection({
              scope: storageScope,
              workspaceDir: info.workspaceDir,
              sessionId: info.sessionId,
              previousHeading,
              heading,
              hint,
              text,
              tags,
              confidence,
            });
          if (result.renamed) {
            return {
              ok: true,
              text: `memory_write: renamed ${storageScope} memory "${result.previousHeading}" → "${result.heading}".`,
              scope: storageScope,
              heading: result.heading,
              previousHeading: result.previousHeading,
              renamed: true,
              replaced: result.replaced,
              unchanged: false,
            };
          }
          const state = result.unchanged ? 'unchanged' : result.replaced ? 'replaced' : 'stored';
          return {
            ok: true,
            text: `memory_write: ${state} ${storageScope} memory "${result.heading}".`,
            scope: storageScope,
            heading: result.heading,
            renamed: false,
            replaced: result.replaced,
            unchanged: result.unchanged,
          };
        } catch (error) {
          if (error instanceof MemoryError) return fail('memory_write', error.code, error.message);
          ctx.logger?.warn?.(`dsh-memory: memory_write failed: ${String(error?.message ?? error)}`);
          return fail('memory_write', 'FAILED', String(error?.message ?? error));
        }
      },
    }), 'dsh-memory:tool-write');

    scope.effect(() => scope.tools.register({
      name: 'memory_read',
      description: 'Read the full body of one memory by scope and heading. Use this when an injected hint matches; never guess the details of a hinted memory.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['heading'],
        properties: {
          scope: { type: 'string', enum: ['auto', 'global', 'workspace', 'session'], description: 'Exact scope, or auto to choose the most specific match. Defaults to auto.' },
          heading: { type: 'string', description: 'The heading shown in the injected hint or returned by memory_search/memory_list.' },
        },
      },
      output: toolOutput({
        scope: { type: 'string' },
        heading: { type: 'string' },
        body: { type: 'string' },
        hint: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number' },
      }),
      async execute(args, exec) {
        try {
          const info = withAgentContext(ctx, exec);
          const requestedScope = validateScope(args.scope, ['auto', 'global', 'workspace', 'session']) ?? 'auto';
          const heading = validateHeading(args.heading);
          const row = service.readSection({
            scope: requestedScope,
            heading,
            workspaceDir: info.workspaceDir,
            sessionId: info.sessionId,
          });
          if (!row) return fail('memory_read', 'NOT_FOUND', `no active memory "${heading}"`);
          return {
            ok: true,
            text: formatRead(row),
            scope: row.scope,
            heading: row.heading,
            body: row.body,
            hint: row.hint,
            tags: row.tags,
            confidence: row.confidence,
          };
        } catch (error) {
          if (error instanceof MemoryError) return fail('memory_read', error.code, error.message);
          ctx.logger?.warn?.(`dsh-memory: memory_read failed: ${String(error?.message ?? error)}`);
          return fail('memory_read', 'FAILED', String(error?.message ?? error));
        }
      },
    }), 'dsh-memory:tool-read');

    scope.effect(() => scope.tools.register({
      name: 'memory_search',
      description: 'Full-text search memory headings, hints, and bodies. Returns compact snippets; use memory_read for the full entry. A Latin query without spaces requires every token (exact identifiers); multi-word or Chinese queries match any token and rank by relevance.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Words or a phrase. A Latin query without spaces requires every token (exact identifier); a multi-word or Chinese query matches any token and ranks by relevance.' },
          scope: { type: 'string', enum: ['all', 'global', 'workspace', 'session'], description: 'Limit to one scope. Defaults to all.' },
          limit: { type: 'integer', description: 'Maximum results, 1 to 20. Defaults to 8.' },
        },
      },
      output: toolOutput({
        count: { type: 'integer' },
      }),
      async execute(args, exec) {
        try {
          const info = withAgentContext(ctx, exec);
          const query = validateString(args.query, 'query', 500);
          const requestedScope = validateScope(args.scope, ['all', 'global', 'workspace', 'session']) ?? 'all';
          const limit = validateLimit(args.limit, 8, 20);
          const rows = service.search({
            query,
            scope: requestedScope,
            workspaceDir: info.workspaceDir,
            sessionId: info.sessionId,
            limit,
          });
          return { ok: true, text: formatSearch(rows), count: rows.length };
        } catch (error) {
          if (error instanceof MemoryError) return fail('memory_search', error.code, error.message);
          ctx.logger?.warn?.(`dsh-memory: memory_search failed: ${String(error?.message ?? error)}`);
          return fail('memory_search', 'FAILED', String(error?.message ?? error));
        }
      },
    }), 'dsh-memory:tool-search');

    scope.effect(() => scope.tools.register({
      name: 'memory_list',
      description: 'List available memory headings and hints without bodies. Use memory_read to fetch one entry.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', enum: ['all', 'global', 'workspace', 'session'], description: 'Limit to one scope. Defaults to all.' },
          limit: { type: 'integer', description: 'Maximum entries, 1 to 100. Defaults to 30.' },
        },
      },
      output: toolOutput({
        count: { type: 'integer' },
      }),
      async execute(args, exec) {
        try {
          const info = withAgentContext(ctx, exec);
          const requestedScope = validateScope(args.scope, ['all', 'global', 'workspace', 'session']) ?? 'all';
          const limit = validateLimit(args.limit, 30, 100);
          const rows = service.list({
            scope: requestedScope,
            workspaceDir: info.workspaceDir,
            sessionId: info.sessionId,
            limit,
          });
          return { ok: true, text: formatList(rows), count: rows.length };
        } catch (error) {
          if (error instanceof MemoryError) return fail('memory_list', error.code, error.message);
          ctx.logger?.warn?.(`dsh-memory: memory_list failed: ${String(error?.message ?? error)}`);
          return fail('memory_list', 'FAILED', String(error?.message ?? error));
        }
      },
    }), 'dsh-memory:tool-list');

    scope.effect(() => scope.tools.register({
      name: 'memory_forget',
      description: 'Permanently remove one memory entry. Deleting a global entry affects every workspace. Only use after the user explicitly asks or approves.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'heading', 'confirm'],
        properties: {
          scope: { type: 'string', enum: ['global', 'workspace', 'session'], description: 'Scope of the entry to remove.' },
          heading: { type: 'string', description: 'Exact heading of the entry to remove.' },
          confirm: { type: 'boolean', description: 'Must be true. Set it only after the user explicitly asks or approves the deletion.' },
        },
      },
      output: toolOutput({
        scope: { type: 'string' },
        heading: { type: 'string' },
      }),
      async execute(args, exec) {
        try {
          const info = withAgentContext(ctx, exec);
          const scopeName = validateScope(args.scope, ['global', 'workspace', 'session']);
          if (!scopeName) throw new MemoryError('INVALID_ARGUMENT', 'scope is required');
          const heading = validateHeading(args.heading);
          if (args.confirm !== true) {
            return fail('memory_forget', 'CONFIRM_REQUIRED', 'set confirm: true only after the user approves');
          }
          service.forget({
            scope: scopeName,
            heading,
            workspaceDir: info.workspaceDir,
            sessionId: info.sessionId,
            confirm: true,
          });
          return { ok: true, text: `memory_forget: removed ${scopeName} memory "${heading}".`, scope: scopeName, heading };
        } catch (error) {
          if (error instanceof MemoryError) return fail('memory_forget', error.code, error.message);
          ctx.logger?.warn?.(`dsh-memory: memory_forget failed: ${String(error?.message ?? error)}`);
          return fail('memory_forget', 'FAILED', String(error?.message ?? error));
        }
      },
    }), 'dsh-memory:tool-forget');

    scope.effect(() => scope.tools.register({
      name: 'memory_compact',
      description: 'Replace one scope\'s memory with a compacted set of entries. Read memory_list or memory_read first; omitted entries are deleted and tombstoned. Metadata for kept headings is preserved when tags or confidence are omitted. Use this to prune session or workspace memory deliberately.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['entries', 'confirm'],
        properties: {
          scope: { type: 'string', enum: ['global', 'workspace', 'session'], description: 'Scope to compact. Defaults to the configured default scope.' },
          entries: {
            type: 'array',
            description: 'The complete new entry set for this scope, in display order.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['heading', 'text'],
              properties: {
                heading: { type: 'string', description: 'One-line heading.' },
                text: { type: 'string', description: 'Entry body.' },
                hint: { type: 'string', description: 'Retrieval hint. Omitted keeps the current hint for an existing heading.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags. Omitted keeps the current tags for an existing heading.' },
                confidence: { type: 'number', description: 'Confidence from 0 to 1. Omitted keeps the current confidence for an existing heading.' },
              },
            },
          },
          confirm: { type: 'boolean', description: 'Must be true. Entries omitted from the array are deleted and tombstoned.' },
        },
      },
      output: toolOutput({
        scope: { type: 'string' },
        kept: { type: 'integer' },
        added: { type: 'integer' },
        removed: { type: 'integer' },
      }),
      async execute(args, exec) {
        try {
          const info = withAgentContext(ctx, exec);
          const effective = configFor(info.workspaceDir);
          const scopeName = validateScope(args.scope, ['global', 'workspace', 'session']) ?? defaultScope(effective, info);
          if (args.confirm !== true) {
            return fail('memory_compact', 'CONFIRM_REQUIRED', 'set confirm: true to replace the scope');
          }
          if (!Array.isArray(args.entries)) throw new MemoryError('INVALID_ARGUMENT', 'entries must be an array');
          if (args.entries.length > 100) throw new MemoryError('INVALID_ARGUMENT', 'at most 100 entries can be compacted at once');
          const entries = args.entries.map((entry) => {
            if (!entry || typeof entry !== 'object') throw new MemoryError('INVALID_ARGUMENT', 'each entry must be an object');
            return {
              heading: validateHeading(entry.heading),
              text: validateString(entry.text, 'text', TOOL_TEXT_MAX),
              hint: entry.hint === undefined ? undefined : validateHint(entry.hint),
              tags: validateTags(entry.tags),
              confidence: entry.confidence === undefined ? undefined : validateConfidence(entry.confidence),
            };
          });
          const result = service.compactScope({
            scope: scopeName,
            workspaceDir: info.workspaceDir,
            sessionId: info.sessionId,
            entries,
          });
          return {
            ok: true,
            text: `memory_compact: kept ${result.kept}, added ${result.added}, removed ${result.removed} in ${scopeName}.`,
            scope: scopeName,
            kept: result.kept,
            added: result.added,
            removed: result.removed,
          };
        } catch (error) {
          if (error instanceof MemoryError) return fail('memory_compact', error.code, error.message);
          ctx.logger?.warn?.(`dsh-memory: memory_compact failed: ${String(error?.message ?? error)}`);
          return fail('memory_compact', 'FAILED', String(error?.message ?? error));
        }
      },
    }), 'dsh-memory:tool-compact');
  });

  ctx.inject(['webServer', 'connection'], (scope) => {
    const resolveRequestContext = (sessionId) => {
      const sessions = ctx.get('sessions');
      const session = sessionId ? sessions?.get?.(sessionId) : undefined;
      let workspaceDir = typeof session?.header?.cwd === 'string' ? session.header.cwd : '';
      if (workspaceDir === '' && session) {
        try {
          workspaceDir = ctx.get('workingDirectory')?.get?.(session) ?? '';
        } catch {
          workspaceDir = '';
        }
      }
      return { workspaceDir, sessionId: typeof sessionId === 'string' ? sessionId : '' };
    };

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/dsh-memory/anomalies',
      handler: (req, res) => {
        const rejection = scope.connection.requestRejection(req);
        if (rejection !== undefined) {
          res.writeHead(rejection).end();
          return;
        }
        if (req.method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const info = resolveRequestContext(url.searchParams.get('sessionId') ?? '');
          try {
            service.syncContext(info);
            const anomalies = service.listAnomalies(info);
            writeJson(res, 200, {
              ok: true,
              anomalies,
              counts: {
                sections: anomalies.filter((item) => item.kind === 'section').length,
                files: anomalies.filter((item) => item.kind === 'file').length,
              },
            });
          } catch (error) {
            writeJson(res, 500, { ok: false, code: 'FAILED', message: String(error?.message ?? error) });
          }
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, POST' }).end();
          return;
        }
        void (async () => {
          try {
            const body = await readBody(req);
            const info = resolveRequestContext(body?.sessionId ?? '');
            const action = body?.action;
            if (action === 'approve') {
              service.approveAnomaly({ ...info, scope: body.scope, heading: body.heading, fromHeading: body.fromHeading });
            } else if (action === 'delete') {
              service.deleteAnomaly({ ...info, scope: body.scope, heading: body.heading, fromHeading: body.fromHeading });
            } else if (action === 'retry') {
              service.retryAnomaly({ ...info, scope: body.scope });
            } else if (action === 'rebuild') {
              service.rebuildAnomaly({ ...info, scope: body.scope });
            } else {
              throw new MemoryError('INVALID_ACTION', 'action must be approve, delete, retry, or rebuild');
            }
            const anomalies = service.listAnomalies(info);
            writeJson(res, 200, {
              ok: true,
              action,
              anomalies,
              counts: {
                sections: anomalies.filter((item) => item.kind === 'section').length,
                files: anomalies.filter((item) => item.kind === 'file').length,
              },
            });
          } catch (error) {
            const status = error instanceof MemoryError ? 400 : 500;
            writeJson(res, status, {
              ok: false,
              code: error instanceof MemoryError ? error.code : 'FAILED',
              message: String(error?.message ?? error),
            });
          }
        })();
      },
    }), 'dsh-memory:anomalies-route');
  });
}
