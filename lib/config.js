import fs from 'node:fs';
import path from 'node:path';
import { isRecord } from './util.js';

export const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  autoInject: true,
  verbosity: 3,
  defaultScope: 'workspace',
  memoryMaxChars: 2000,
  globalFullMaxChars: 1000,
  maxIndexEntries: 24,
  maxIndexChars: 1200,
  autoCapture: false,
});

/** Workspace files may override only these keys. */
export const WORKSPACE_CONFIG_KEYS = Object.freeze(['verbosity', 'autoInject', 'defaultScope']);

const SCOPES = new Set(['global', 'workspace', 'session']);

export function globalConfigPath(homeDir) {
  return path.join(homeDir, 'memory', 'config.json');
}

export function workspaceConfigPath(workspaceDir) {
  return path.join(workspaceDir, '.DSH', 'memory.json');
}

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    return undefined;
  }
}

function boundedInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return undefined;
  return Math.min(max, Math.max(min, number));
}

/**
 * Keep only recognized keys and valid values. Workspace files pass through a
 * narrower allowlist so a repository cannot change budgets or disable safety.
 */
export function sanitizeConfig(raw, { workspace = false } = {}) {
  if (!isRecord(raw)) return {};
  const out = {};
  const assign = (key, value) => {
    if (workspace && !WORKSPACE_CONFIG_KEYS.includes(key)) return;
    out[key] = value;
  };
  if (typeof raw.enabled === 'boolean') assign('enabled', raw.enabled);
  if (typeof raw.autoInject === 'boolean') assign('autoInject', raw.autoInject);
  if (typeof raw.autoCapture === 'boolean') assign('autoCapture', raw.autoCapture);
  if (raw.verbosity === null || raw.verbosity === 0) {
    assign('verbosity', null);
  } else {
    const verbosity = boundedInteger(raw.verbosity, 1, 5);
    if (verbosity !== undefined) assign('verbosity', verbosity);
  }
  if (SCOPES.has(raw.defaultScope)) assign('defaultScope', raw.defaultScope);
  const memoryMaxChars = boundedInteger(raw.memoryMaxChars, 200, 20000);
  if (memoryMaxChars !== undefined) assign('memoryMaxChars', memoryMaxChars);
  const globalFullMaxChars = boundedInteger(raw.globalFullMaxChars, 100, 20000);
  if (globalFullMaxChars !== undefined) assign('globalFullMaxChars', globalFullMaxChars);
  const maxIndexEntries = boundedInteger(raw.maxIndexEntries, 1, 200);
  if (maxIndexEntries !== undefined) assign('maxIndexEntries', maxIndexEntries);
  const maxIndexChars = boundedInteger(raw.maxIndexChars, 100, 20000);
  if (maxIndexChars !== undefined) assign('maxIndexChars', maxIndexChars);
  return out;
}

export function resolveConfig({ homeDir, workspaceDir, pluginConfig } = {}) {
  let merged = { ...CONFIG_DEFAULTS, ...sanitizeConfig(pluginConfig) };
  if (homeDir) merged = { ...merged, ...sanitizeConfig(readJsonFile(globalConfigPath(homeDir))) };
  if (homeDir && workspaceDir) {
    merged = { ...merged, ...sanitizeConfig(readJsonFile(workspaceConfigPath(workspaceDir)), { workspace: true }) };
  }
  merged.memoryMaxChars = boundedInteger(merged.memoryMaxChars, 200, 20000) ?? CONFIG_DEFAULTS.memoryMaxChars;
  merged.globalFullMaxChars = Math.min(
    merged.memoryMaxChars,
    boundedInteger(merged.globalFullMaxChars, 100, 20000) ?? CONFIG_DEFAULTS.globalFullMaxChars,
  );
  merged.maxIndexChars = Math.min(
    merged.memoryMaxChars,
    boundedInteger(merged.maxIndexChars, 100, 20000) ?? CONFIG_DEFAULTS.maxIndexChars,
  );
  merged.maxIndexEntries = boundedInteger(merged.maxIndexEntries, 1, 200) ?? CONFIG_DEFAULTS.maxIndexEntries;
  merged.verbosity = merged.verbosity === null || merged.verbosity === 0
    ? null
    : boundedInteger(merged.verbosity, 1, 5) ?? CONFIG_DEFAULTS.verbosity;
  merged.defaultScope = SCOPES.has(merged.defaultScope) ? merged.defaultScope : CONFIG_DEFAULTS.defaultScope;
  merged.enabled = typeof merged.enabled === 'boolean' ? merged.enabled : CONFIG_DEFAULTS.enabled;
  merged.autoInject = typeof merged.autoInject === 'boolean' ? merged.autoInject : CONFIG_DEFAULTS.autoInject;
  merged.autoCapture = typeof merged.autoCapture === 'boolean' ? merged.autoCapture : CONFIG_DEFAULTS.autoCapture;
  return Object.freeze(merged);
}
