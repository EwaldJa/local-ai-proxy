import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Ollama } from '../src/ollama.js';

async function server(t, handler, limit = 1048576) {
  const http = createServer(handler);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  return new Ollama({ ollama: { url: `http://127.0.0.1:${http.address().port}`, timeoutMs: 3000 },
    limits: { maxResponseBytes: limit } });
}

test('HTTP model discovery distinguishes metadata capacity from running context', async t => {
  const backend = await server(t, async (req, res) => {
    const responses = {
      '/api/tags': { models: [{ name: 'worker', details: { parameter_size: '8B' } }] },
      '/api/ps': { models: [{ name: 'worker', context_length: 4096 }] },
      '/api/show': { capabilities: ['completion'], model_info: { 'general.architecture': 'test', 'test.context_length': 32768 } }
    };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(responses[req.url]));
  });
  const [model] = await backend.models();
  assert.equal(model.maxContextTokens, 32768);
  assert.equal(model.loadedContextTokens, 4096);
  assert.equal(model.loaded, true);
});

test('HTTP chat sends the task schema, bounded runtime context and thinking preference', async t => {
  let sent;
  const backend = await server(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    sent = JSON.parse(Buffer.concat(chunks));
    res.end(JSON.stringify({ message: { content: '{}' }, eval_count: 5 }));
  });
  const response = await backend.generate({ model: 'worker', messages: [{ role: 'user', content: 'Task' }],
    schema: { type: 'object' }, contextTokens: 4096, outputTokens: 512, think: false });
  assert.equal(sent.stream, false);
  assert.equal(sent.truncate, false);
  assert.equal(sent.shift, false);
  assert.equal(sent.options.num_ctx, 4096);
  assert.equal(sent.options.num_predict, 512);
  assert.equal(sent.think, false);
  assert.deepEqual(sent.format, { type: 'object' });
  assert.equal(response.eval_count, 5);
});

test('discovery identifies upstream models instead of selecting them as local workers', async t => {
  const backend = await server(t, (req, res) => {
    const result = req.url === '/api/tags'
      ? { models: [{ name: 'remote-alias', remote_host: 'https://example.invalid', remote_model: 'remote' }] }
      : { models: [] };
    res.end(JSON.stringify(result));
  });
  const [model] = await backend.models();
  assert.equal(model.remote, true);
});

test('HTTP rejects redirects rather than forwarding credentials', async t => {
  const backend = await server(t, (_, res) => { res.writeHead(302, { Location: 'http://127.0.0.1:1' }); res.end(); });
  await assert.rejects(backend.request('/api/tags'));
});

test('HTTP limits response bytes, including a chunked body', async t => {
  const backend = await server(t, (_, res) => { res.write('a'.repeat(100)); res.end('b'.repeat(100)); }, 50);
  await assert.rejects(backend.request('/api/tags'), /maxResponseBytes/);
});
