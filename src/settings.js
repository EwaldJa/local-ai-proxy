import * as z from 'zod/v4';
import { readConfigFile, resolveConfig, updateConfig } from './config.js';
import { Ollama } from './ollama.js';

const connection = z.object({
  url: z.string().min(1).max(2000),
  allowInsecureLanHttp: z.boolean(),
  tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).nullable()
}).strict();
const valuesSchema = connection.extend({
  defaultModel: z.string().min(1).max(200).nullable(),
  defaultMode: z.enum(['auto', 'manual', 'off']),
  minContextTokens: z.number().int().positive(),
  outputTokens: z.number().int().positive().optional()
}).strict();

function mergeSettings(raw, values) {
  return { ...raw,
    ollama: { ...raw.ollama, url: values.url, allowInsecureLanHttp: values.allowInsecureLanHttp, tokenEnv: values.tokenEnv },
    models: { ...raw.models, default: values.defaultModel },
    delegation: { ...raw.delegation, defaultMode: values.defaultMode },
    limits: { ...raw.limits, minContextTokens: values.minContextTokens,
      ...(values.outputTokens === undefined ? {} : { outputTokens: values.outputTokens }) }
  };
}

export function registerSettings(server, config) {
  async function current() {
    const { raw, revision } = await readConfigFile(config.configFile);
    const saved = await resolveConfig(raw, config.configFile);
    return { revision, values: {
      url: saved.ollama.url, allowInsecureLanHttp: saved.ollama.allowInsecureLanHttp === true,
      tokenEnv: saved.ollama.tokenEnv, defaultModel: saved.models.default,
      defaultMode: saved.delegation.defaultMode, minContextTokens: saved.limits.minContextTokens,
      outputTokens: saved.limits.outputTokens
    }, fixedModelContextTokens: saved.models.profiles[saved.models.default]?.contextTokens ?? null,
    fixedModelOutputTokens: saved.models.profiles[saved.models.default]?.outputTokens ?? null };
  }
  function register(name, schema, readOnlyHint, handler) {
    server.registerTool(name, {
      inputSchema: schema,
      description: 'Configure Local AI Proxy from its settings form.',
      annotations: { readOnlyHint, destructiveHint: false, openWorldHint: name === 'local_settings_models' },
      _meta: { ui: { visibility: ['app'] } }
    }, async input => {
      try {
        const result = await handler(input);
        return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        const message = error.message === 'fetch failed' ? 'Impossible de joindre Ollama. Vérifie l’adresse et l’accès réseau.' : error.message;
        return { isError: true, content: [{ type: 'text', text: message.slice(0, 2000) }] };
      }
    });
  }
  register('local_settings_get', z.object({}).strict(), true, current);
  register('local_settings_models', connection, true, async input => {
    const { raw } = await readConfigFile(config.configFile);
    const candidate = await resolveConfig({ ...raw, ollama: { ...raw.ollama, ...input } }, config.configFile);
    candidate.ollama.timeoutMs = Math.min(candidate.ollama.timeoutMs, 6000);
    const models = await new Ollama(candidate).models();
    return { models: models.filter(model => !model.remote && !model.metadataError &&
      (!model.capabilities || model.capabilities.includes('completion'))).map(model => ({ name: model.name, maxContextTokens: model.maxContextTokens })) };
  });
  register('local_settings_save', z.object({ revision: z.string().regex(/^[0-9a-f]{64}$/), values: valuesSchema }).strict(), false, async input => {
    // Persist for the next plugin process. Running and queued work keeps its
    // original endpoint, model profiles and limits until the user reloads.
    await updateConfig(config, (raw, revision) => {
      if (revision !== input.revision) throw new Error('Les réglages ont changé. Recharge les valeurs avant de les enregistrer.');
      return mergeSettings(raw, input.values);
    });
    return { ...await current(), reloadRequired: true };
  });
}
