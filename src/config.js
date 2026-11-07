import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { writeFileAtomically } from './atomic-file.js';

function isPrivateLan(hostname) {
  if (!isIPv4(hostname)) return false;
  const [first, second] = hostname.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function chatStateDir(config, chatId) {
  const key = createHash('sha256').update(chatId).digest('hex');
  return path.join(config.stateDir, `chat-${key}`);
}

export async function loadConfig(file = process.env.LOCAL_AI_CONFIG) {
  const configFile = path.resolve(file || 'local-ai.config.json');
  let raw = {};
  try { raw = JSON.parse(await fs.readFile(configFile, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT' || file) throw e; }
  // Resolve workspace paths relative to the private config, even when Codex
  // starts the installed plugin from its own directory.
  const root = path.dirname(configFile);
  const url = new URL(raw.ollama?.url || 'http://127.0.0.1:11434');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP(S) Ollama URL without embedded credentials, query or fragment.');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    if (raw.ollama?.allowInsecureLanHttp !== true || !isPrivateLan(url.hostname)) {
      throw new Error('Use HTTPS for remote Ollama, or explicitly enable allowInsecureLanHttp for a private IPv4 address.');
    }
    if (raw.ollama.tokenEnv) throw new Error('Use HTTPS for Ollama bearer tokens over the LAN.');
  }
  const config = {
    configFile,
    workspace: await fs.realpath(path.resolve(root, raw.workspace || '.')),
    ollama: { timeoutMs: 300000, tokenEnv: null, ...raw.ollama, url: url.href.replace(/\/$/, '') },
    models: { default: null, byTask: {}, profiles: {}, ...raw.models },
    delegation: { defaultMode: 'manual', workspaceFiles: true, ...raw.delegation },
    limits: { contextTokens: 8192, outputTokens: 2048, contextMarginTokens: 512,
      maxFileBytes: 1048576, maxResponseBytes: 4194304, ...raw.limits },
    git: { branchPerChat: false, commits: 'manual', ...raw.git }
  };
  for (const [key, value] of Object.entries(config.limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid limit: ${key}`);
  }
  if (!Number.isSafeInteger(config.ollama.timeoutMs) || config.ollama.timeoutMs < 1) throw new Error('Invalid timeoutMs');
  if (!['auto', 'manual', 'off'].includes(config.delegation.defaultMode)
      || typeof config.delegation.workspaceFiles !== 'boolean') throw new Error('Invalid delegation settings');
  config.stateDir = path.join(config.workspace, '.local-ai');
  return config;
}

export async function savePreferences(config, preferences) {
  const previous = await fs.readFile(config.configFile, 'utf8').then(JSON.parse).catch(e => {
    if (e.code === 'ENOENT') return {};
    throw e;
  });
  const next = { ...previous, models: preferences };
  await writeFileAtomically(config.configFile, JSON.stringify(next, null, 2) + '\n');
  config.models = preferences;
}
