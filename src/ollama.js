export class Ollama {
  constructor(config) { this.config = config; }

  async request(endpoint, body, signal) {
    const headers = { 'Content-Type': 'application/json' };
    const token = this.config.ollama.tokenEnv && process.env[this.config.ollama.tokenEnv];
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(this.config.ollama.url + endpoint, {
      method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Keep prompts and credentials on the configured origin.
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(this.config.ollama.timeoutMs), ...(signal ? [signal] : [])])
    });
    if (!response.ok) throw new Error(`Ollama ${endpoint}: HTTP ${response.status}`);
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > this.config.limits.maxResponseBytes) throw new Error('Ollama response exceeds maxResponseBytes');
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data.error) throw new Error(`Ollama: ${data.error}`);
    return data;
  }

  async models() {
    const [tags, ps] = await Promise.all([
      this.request('/api/tags'), this.request('/api/ps').catch(() => ({ models: [] }))
    ]);
    return Promise.all((tags.models || []).map(async item => {
      const name = item.name || item.model;
      if (item.remote_host || item.remote_model) return {
        name, available: true, remote: true, capabilities: item.capabilities || null,
        remoteHost: item.remote_host || null
      };
      let detail;
      try { detail = await this.request('/api/show', { model: name }); }
      catch (e) { return { name, available: true, metadataError: e.message, capabilities: null }; }
      const loaded = ps.models?.find(m => (m.name || m.model) === name);
      const architecture = detail.model_info?.['general.architecture'];
      const context = detail.model_info?.[`${architecture}.context_length`];
      return { name, available: true, remote: Boolean(detail.remote_host || detail.remote_model),
        remoteHost: detail.remote_host || null, capabilities: detail.capabilities || null,
        maxContextTokens: Number.isSafeInteger(context) ? context : null,
        loadedContextTokens: loaded?.context_length || null,
        loaded: Boolean(loaded), details: item.details || {}, thinking: detail.thinking || null };
    }));
  }

  async generate({ model, messages, schema, contextTokens, outputTokens, think }, signal) {
    return this.request('/api/chat', {
      model, messages, format: schema, stream: false, truncate: false, shift: false,
      ...(think === undefined ? {} : { think }),
      options: { num_ctx: contextTokens, num_predict: outputTokens, temperature: 0 }
    }, signal);
  }
}

export function chooseModel(models, preferences, type, explicit) {
  const preferred = explicit || (Object.hasOwn(preferences.byTask, type) ? preferences.byTask[type] : null) || preferences.default;
  const usable = models.filter(m => !m.metadataError && !m.remote && (!m.capabilities || m.capabilities.includes('completion')));
  if (preferred) {
    const found = usable.find(m => m.name === preferred);
    if (!found) throw new Error(`Model unavailable for text tasks: ${preferred}. Refresh models or update preferences.`);
    return found;
  }
  if (usable.length === 1) return usable[0];
  throw new Error(usable.length ? 'Choose a model explicitly or set a default/task preference.' : 'No usable completion model found.');
}

export function usageFrom(response, contextTokens, wallMs) {
  const count = name => Number.isFinite(response[name]) && response[name] >= 0 ? response[name] : null;
  const input = count('prompt_eval_count');
  const output = count('eval_count');
  const duration = count('eval_duration');
  return {
    inputTokens: input, outputTokens: output,
    generationTokensPerMinute: output !== null && duration > 0 ? output * 60e9 / duration : null,
    evalDurationNs: duration, wallMs,
    endToEndTokensPerMinute: output !== null && wallMs > 0 ? output * 60000 / wallMs : null,
    requestedContextTokens: contextTokens,
    observedPromptFillPercent: input !== null ? input * 100 / contextTokens : null,
    observedPromptAndOutputPercent: input !== null && output !== null ? (input + output) * 100 / contextTokens : null,
    contextMeasurement: 'Post-response token counts / requested num_ctx; not live KV-cache occupancy.'
  };
}
