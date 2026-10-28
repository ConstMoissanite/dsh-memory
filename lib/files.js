import fs from 'node:fs';
import path from 'node:path';
import { safeSegment, workspaceKey } from './util.js';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function atomicWriteText(file, content) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(temp, 0o600);
  } catch {
    // POSIX-only hygiene.
  }
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // POSIX-only hygiene.
  }
}

export function removeFileIfExists(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function memoryRoot(homeDir) {
  return path.join(homeDir, 'memory');
}

export function globalMemoryPath(homeDir) {
  return path.join(memoryRoot(homeDir), 'MEMORY.md');
}

export function workspaceMemoryDir(homeDir, workspaceDir) {
  return path.join(memoryRoot(homeDir), 'workspaces', workspaceKey(workspaceDir));
}

export function workspaceMemoryPath(homeDir, workspaceDir) {
  return path.join(workspaceMemoryDir(homeDir, workspaceDir), 'MEMORY.md');
}

export function sessionMemoryDir(homeDir, workspaceDir, sessionId) {
  return path.join(workspaceMemoryDir(homeDir, workspaceDir), safeSegment(sessionId));
}

export function sessionMemoryPath(homeDir, workspaceDir, sessionId) {
  return path.join(sessionMemoryDir(homeDir, workspaceDir, sessionId), 'MEMORY.md');
}

export function databasePath(homeDir) {
  return path.join(memoryRoot(homeDir), 'index.db');
}

export function defaultFileHeader(scope) {
  if (scope === 'global') return '# DSH Memory\n\n';
  return `# DSH Memory — ${scope}\n\n`;
}
