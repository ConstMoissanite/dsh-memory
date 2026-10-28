import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG_DEFAULTS,
  globalConfigPath,
  resolveConfig,
  sanitizeConfig,
  workspaceConfigPath,
} from '../lib/config.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-config-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, '.DSH'), { recursive: true });
  return { root, home, workspace, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('defaults and workspace-only allowlist', () => {
  const fx = fixture();
  try {
    fs.mkdirSync(path.dirname(globalConfigPath(fx.home)), { recursive: true });
    fs.writeFileSync(globalConfigPath(fx.home), JSON.stringify({
      memoryMaxChars: 3000,
      verbosity: 4,
      enabled: false,
    }));
    fs.writeFileSync(workspaceConfigPath(fx.workspace), JSON.stringify({
      verbosity: 2,
      autoInject: false,
      defaultScope: 'session',
      memoryMaxChars: 9000,
      enabled: true,
    }));
    const config = resolveConfig({ homeDir: fx.home, workspaceDir: fx.workspace });
    assert.equal(config.memoryMaxChars, 3000);
    assert.equal(config.verbosity, 2);
    assert.equal(config.autoInject, false);
    assert.equal(config.defaultScope, 'session');
    assert.equal(config.enabled, false);
  } finally {
    fx.cleanup();
  }
});

test('workspace cannot override budgets or enabled', () => {
  const sanitized = sanitizeConfig({
    memoryMaxChars: 9000,
    enabled: false,
    verbosity: 5,
    autoInject: false,
    defaultScope: 'global',
  }, { workspace: true });
  assert.deepEqual(sanitized, { verbosity: 5, autoInject: false, defaultScope: 'global' });
});

test('verbosity null disables the response-style section', () => {
  const fx = fixture();
  try {
    fs.writeFileSync(workspaceConfigPath(fx.workspace), JSON.stringify({ verbosity: null }));
    const config = resolveConfig({ homeDir: fx.home, workspaceDir: fx.workspace });
    assert.equal(config.verbosity, null);
  } finally {
    fx.cleanup();
  }
});

test('clamps invalid values back to safe defaults', () => {
  const fx = fixture();
  try {
    fs.writeFileSync(workspaceConfigPath(fx.workspace), JSON.stringify({ verbosity: 99 }));
    const config = resolveConfig({ homeDir: fx.home, workspaceDir: fx.workspace });
    assert.equal(config.verbosity, 5);
    assert.equal(config.memoryMaxChars, CONFIG_DEFAULTS.memoryMaxChars);
    assert.ok(config.globalFullMaxChars <= config.memoryMaxChars);
    assert.ok(config.maxIndexChars <= config.memoryMaxChars);
  } finally {
    fx.cleanup();
  }
});
