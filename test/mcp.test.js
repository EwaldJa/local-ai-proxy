import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { chatStateDir } from '../src/config.js';

test('MCP STDIO: discovery, background task, review, apply and statistics work end to end', { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-mcp-test-'));
  let doneReason = 'stop';
  const backend = createServer(async (req, res) => {
    for await (const _ of req) { /* consume the request body */ }
    const data = {
      '/api/tags': { models: [{ name: 'fixture:latest' }] },
      '/api/ps': { models: [] },
      '/api/show': { capabilities: ['completion'], model_info: { 'general.architecture': 'fixture', 'fixture.context_length': 8192 } },
      '/api/chat': { done: true, done_reason: doneReason, prompt_eval_count: 100, eval_count: 50, eval_duration: 1e9,
        message: { content: JSON.stringify({ status: 'completed', summary: 'Brief reformatted', text: 'ok',
          changes: [{ op: 'write', path: 'brief.md', content: 'SSO and CSV are required.\n' }] }) } }
    };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data[req.url]));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const config = path.join(root, 'config.json');
  await fs.writeFile(config, JSON.stringify({ workspace: root,
    ollama: { url: `http://127.0.0.1:${backend.address().port}` } }));
  const child = spawn(process.execPath, [path.resolve('src/mcp.js')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LOCAL_AI_CONFIG: config }
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const pending = new Map();
  let nextId = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (!pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  child.once('exit', code => {
    for (const { reject } of pending.values()) reject(new Error(`MCP exited ${code}: ${stderr}`));
    pending.clear();
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args = {}, threadId = 'mcp-chat') => {
    const result = await rpc('tools/call', { name: `local_${name}`, arguments: args, _meta: { threadId } });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  async function waitForTask(taskId) {
    return tool('task', { taskId, waitMs: 2000, proposalChars: 4000 });
  }
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) {
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1000)]);
      if (child.exitCode === null) child.kill();
    }
    lines.close();
    await new Promise(resolve => { backend.close(resolve); backend.closeAllConnections(); });
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('local-ai-mcp-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'local-ai-test', version: '1.0.0' } });
  assert.equal(init.serverInfo.name, 'local-ai-proxy');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await rpc('tools/list', {});
  assert.equal(tools.tools.length, 14);
  assert.equal(tools.tools.find(x => x.name === 'local_stats').annotations.readOnlyHint, true);
  assert.equal(tools.tools.find(x => x.name === 'local_apply').annotations.destructiveHint, true);
  const panel = tools.tools.find(x => x.name === 'local_status_panel');
  assert.deepEqual(panel._meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
  const resource = await rpc('resources/read', { uri: panel._meta.ui.resourceUri });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.contents[0].text, /Tokens traités/);
  const emptyMetrics = { localRequests: 0, localInputTokens: 0, localOutputTokens: 0,
    acceptedResponses: 0, rejectedResponses: 0, awaitingReview: 0, needsContextResponses: 0,
    generationTokensPerMinute: null, lastContext: null, recentRequests: [] };
  assert.deepEqual(await tool('status_panel'), { mode: 'manual', ...emptyMetrics });
  assert.equal((await tool('models')).models[0].name, 'fixture:latest');
  assert.deepEqual((await tool('flow')).chatId, 'mcp-chat');
  await tool('flow', { mode: 'off' }, 'other-chat');
  assert.equal((await tool('flow', {}, 'other-chat')).mode, 'off');
  assert.equal((await tool('flow')).mode, 'manual');
  await tool('plan', { goal: 'Reformat a presales brief', steps: [
    { id: 'format', executor: 'local', title: 'Reformat', taskType: 'writing', weight: 1 }
  ] });
  const submitted = await tool('submit', { stepId: 'format',
    instruction: 'Write the supplied brief in Markdown.', context: 'SSO and CSV are required.',
    allowedOutputs: ['brief.md'], acceptance: ['Preserve both requirements'],
    checks: [{ kind: 'contains', target: 'brief.md', value: 'SSO' }] });
  const status = await waitForTask(submitted.taskId);
  assert.equal(status.status, 'awaiting_review', status.error);
  assert.equal(status.reviewRequired, true);
  assert.match(status.proposal.content, /SSO and CSV are required/);
  const waitingSnapshot = await tool('status_snapshot');
  assert.equal(waitingSnapshot.awaitingReview, 1);
  assert.equal(waitingSnapshot.recentRequests[0].status, 'awaiting_review');
  assert.equal(waitingSnapshot.recentRequests[0].verdict, null);
  assert.equal(waitingSnapshot.recentRequests[0].rejectionReason, null);
  await tool('review', { taskId: submitted.taskId, decision: 'accept', evidence: 'Read proposed Markdown and compared to the brief.' });
  await tool('apply', { taskId: submitted.taskId });
  assert.equal(await fs.readFile(path.join(root, 'brief.md'), 'utf8'), 'SSO and CSV are required.\n');
  const next = { goal: 'Continue the same chat', append: true, steps: [
    { id: 'review', executor: 'codex', title: 'Review', taskType: 'review', weight: 1 },
    { id: 'alternative', executor: 'local', title: 'Draft alternative', taskType: 'writing', weight: 1 }
  ] };
  await tool('plan', next);
  await tool('plan', next);
  const stats = await tool('stats');
  assert.equal(stats.acceptedResponses, 1);
  assert.equal(stats.localRequests, 1);
  assert.equal(stats.localOutputTokens, 50);
  assert.equal(stats.codexTokens, null);
  assert.equal(stats.allocation.totalSteps, 3);
  const alternative = await tool('submit', { stepId: 'alternative', instruction: 'Draft an alternative',
    allowedOutputs: ['brief.md'], acceptance: ['Preserve both requirements and add a title'] });
  const alternativeStatus = await waitForTask(alternative.taskId);
  assert.equal(alternativeStatus.status, 'awaiting_review', alternativeStatus.error);
  const rejectionEvidence = 'The alternative did not include a title.';
  await tool('review', { taskId: alternative.taskId, decision: 'reject', evidence: rejectionEvidence });
  const { recentRequests, ...snapshot } = await tool('status_snapshot');
  assert.deepEqual(snapshot, { mode: 'manual', localRequests: 2, localInputTokens: 200, localOutputTokens: 100,
    acceptedResponses: 1, rejectedResponses: 1, awaitingReview: 0, needsContextResponses: 0, generationTokensPerMinute: 3000,
    lastContext: { measuredTokens: 150, requestedTokens: 8192, fillPercent: 150 * 100 / 8192 } });
  assert.deepEqual(recentRequests.map(({ title, preview, verdict }) => ({ title, preview, verdict })), [
    { title: 'Draft alternative', preview: 'Draft an alternative', verdict: 'rejected' },
    { title: 'Reformat', preview: 'Write the supplied brief in Markdown.', verdict: 'accepted' }
  ]);
  for (const row of recentRequests) {
    assert.equal(row.inputTokens, 100);
    assert.equal(row.outputTokens, 50);
    assert.ok(Number.isInteger(row.durationMs) && row.durationMs >= 0);
  }
  assert.deepEqual(recentRequests.map(row => row.startedAt), [alternativeStatus.startedAt, status.startedAt]);
  assert.ok(recentRequests.every(row => Number.isFinite(Date.parse(row.startedAt))));
  assert.deepEqual(recentRequests.map(row => row.rejectionReason), [rejectionEvidence, null]);
  const chatDir = chatStateDir({ stateDir: path.join(root, '.local-ai') }, 'mcp-chat');
  await fs.writeFile(path.join(chatDir, alternative.taskId, 'review.json'), '{');
  const withoutReason = await tool('status_snapshot');
  assert.equal(withoutReason.recentRequests[0].verdict, 'rejected');
  assert.equal(withoutReason.recentRequests[0].rejectionReason, null);

  const checked = await tool('submit', { stepId: 'alternative', instruction: 'Add a title',
    allowedOutputs: ['brief.md'], acceptance: ['Add a title'],
    checks: [{ kind: 'contains', target: 'brief.md', value: '# Brief' }] });
  assert.equal((await waitForTask(checked.taskId)).status, 'validation_failed');
  assert.equal((await tool('status_snapshot')).recentRequests[0].rejectionReason, 'brief.md · Required text missing');

  doneReason = 'length';
  const truncated = await tool('submit', { stepId: 'alternative', instruction: 'Add a title',
    allowedOutputs: ['brief.md'], acceptance: ['Add a title'] });
  assert.equal((await waitForTask(truncated.taskId)).status, 'invalid_response');
  assert.match((await tool('status_snapshot')).recentRequests[0].rejectionReason, /Output token limit reached/);

  assert.deepEqual(await tool('status_snapshot', {}, 'other-chat'), { mode: 'off', ...emptyMetrics });
  assert.equal((await tool('stats', {}, 'other-chat')).localRequests, 0);
  const foreign = await rpc('tools/call', { name: 'local_task', arguments: { taskId: submitted.taskId }, _meta: { threadId: 'other-chat' } });
  assert.equal(foreign.isError, true);
  const paused = await rpc('tools/call', { name: 'local_submit', arguments: {
    stepId: 'test', instruction: 'Write a test', acceptance: ['Valid output']
  }, _meta: { threadId: 'other-chat' } });
  assert.match(paused.content[0].text, /paused/);
});
