import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const configPath = path.resolve(process.argv[2] || path.join(project, 'local-ai.config.json'));
// First-time setup can be completed in the plugin's Codex settings form.
try {
  await fs.writeFile(configPath, JSON.stringify({ workspace: project, delegation: { workspaceFiles: false } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
} catch (error) { if (error.code !== 'EEXIST') throw error; }
await loadConfig(configPath);
const market = path.join(project, '.local-ai', 'marketplace');
const plugin = path.join(market, 'plugins', 'local-ai-proxy');
await fs.mkdir(plugin, { recursive: true });
for (const entry of ['plugin.json', '.codex-plugin', 'package.json', 'pnpm-lock.yaml', 'LICENSE', 'README.md', 'docs', 'src', 'skills']) {
  await fs.cp(path.join(project, entry), path.join(plugin, entry), { recursive: true });
}
for (const entry of ['mcp.json', '.mcp.json']) {
  const manifest = JSON.parse(await fs.readFile(path.join(project, entry), 'utf8'));
  manifest.mcpServers['local-ai-proxy'].env = { LOCAL_AI_CONFIG: configPath };
  await fs.writeFile(path.join(plugin, entry), JSON.stringify(manifest, null, 2) + '\n');
}
const catalog = path.join(market, '.agents', 'plugins');
await fs.mkdir(catalog, { recursive: true });
await fs.writeFile(path.join(catalog, 'marketplace.json'), JSON.stringify({
  name: 'local-ai-proxy-dev',
  interface: { displayName: 'Local AI Proxy' },
  plugins: [{ name: 'local-ai-proxy', source: { source: 'local', path: './plugins/local-ai-proxy' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }]
}, null, 2) + '\n');
console.log(market);
