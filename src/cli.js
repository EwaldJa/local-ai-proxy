import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatStateDir, loadConfig } from './config.js';
import { Ollama } from './ollama.js';
import { Engine } from './engine.js';

let engine;
try {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'init') {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const file = process.env.LOCAL_AI_CONFIG || path.resolve('local-ai.config.json');
    await fs.copyFile(path.join(root, 'local-ai.config.example.json'), file, fs.constants.COPYFILE_EXCL);
    console.log(`Configuration créée : ${file}`);
  } else if (command === 'doctor') {
    const config = await loadConfig();
    const models = await new Ollama(config).models();
    console.log(JSON.stringify({ workspace: config.workspace, ollamaUrl: config.ollama.url,
      models, preferences: config.models, ready: models.some(m => !m.metadataError && !m.remote
        && (!m.capabilities || m.capabilities.includes('completion'))) }, null, 2));
  } else if (command === 'stats') {
    const config = await loadConfig();
    engine = new Engine(config);
    const locations = args[0] ? [chatStateDir(config, args[0]), config.stateDir] : [config.stateDir];
    for (const location of locations) {
      try { engine.state = JSON.parse(await fs.readFile(path.join(location, 'state.json'), 'utf8')); break; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    console.log(JSON.stringify(engine.stats(args[0] ? { chatId: args[0] } : {}), null, 2));
    engine = null;
  } else if (command === 'call') {
    engine = await new Engine(await loadConfig()).init();
    const [method, file] = args;
    const input = file ? JSON.parse(await fs.readFile(file, 'utf8')) : {};
    let result = await engine.call(method, input);
    if (method === 'submit' && result.taskId) {
      await engine.idle(); result = engine.task({ taskId: result.taskId });
    }
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Local AI Proxy 0.3.18
node src/cli.js init                      Créer une configuration personnelle
node src/cli.js doctor                    Tester Ollama et découvrir les modèles
node src/cli.js stats [chatId]            Lire les statistiques, même si MCP tourne
node src/cli.js call <operation> [json]   Exécuter un outil hors du serveur MCP
node src/mcp.js                           Démarrer le serveur MCP STDIO
LOCAL_AI_CONFIG pointe vers le fichier de configuration (chemin absolu conseillé).`);
  }
} catch (e) {
  console.error(e.message); process.exitCode = 1;
} finally { if (engine) await engine.close(); }
