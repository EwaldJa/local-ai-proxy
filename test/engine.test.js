import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { chooseModel, usageFrom } from '../src/ollama.js';
import { Workspace } from '../src/workspace.js';

const names = [{ name: 'worker:latest', capabilities: ['completion'], maxContextTokens: 32768 }];
const proposal = (changes = [], text = 'ok') => ({ status: 'completed', summary: 'Prepared', text, changes });
function fake(output = proposal()) {
  return { calls: [], models: async () => names,
    async generate(input, signal) {
      this.calls.push(input);
      if (signal.aborted) throw new Error('Aborted');
      return { done: true, done_reason: 'stop', message: { content: JSON.stringify(output) },
        prompt_eval_count: 100, eval_count: 200, eval_duration: 2e9 };
    }
  };
}

async function fixture(t, output = proposal(), raw = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-test-'));
  const workspace = path.join(root, 'work');
  await fs.mkdir(workspace);
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, JSON.stringify({ workspace, ...raw }));
  const config = await loadConfig(file);
  const backend = fake(output);
  const engine = await new Engine(config, backend).init();
  t.after(async () => {
    await engine.close();
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('local-ai-test-'));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  await engine.call('plan', { chatId: 'chat-1', goal: 'A general business task', steps: [
    { id: 'local-1', executor: 'local', taskType: 'presales', title: 'Extract requirements', weight: 3 },
    { id: 'review-1', executor: 'codex', taskType: 'review', title: 'Check evidence', weight: 1 }
  ] });
  const submit = async (extra = {}) => engine.call('submit', {
    chatId: 'chat-1', stepId: 'local-1', instruction: 'Produce the specified result',
    acceptance: ['Match the specification'], ...extra
  });
  return { root, workspace, config, backend, engine, submit };
}

test('delegation defaults to auto while explicit config and saved chat modes take precedence', async t => {
  const f = await fixture(t);
  assert.equal(f.config.delegation.defaultMode, 'auto');
  assert.equal((await f.engine.call('flow', { chatId: 'new-chat' })).mode, 'auto');

  const example = JSON.parse(await fs.readFile(new URL('../local-ai.config.example.json', import.meta.url), 'utf8'));
  await fs.writeFile(f.config.configFile, JSON.stringify({ ...example, workspace: f.workspace }));
  assert.equal((await loadConfig(f.config.configFile)).delegation.defaultMode, 'auto');
  for (const mode of ['manual', 'off']) {
    await fs.writeFile(f.config.configFile, JSON.stringify({ workspace: f.workspace, delegation: { defaultMode: mode } }));
    const config = await loadConfig(f.config.configFile);
    assert.equal(new Engine(config, f.backend).modeFor('new-chat'), mode);
  }

  await fs.writeFile(f.config.configFile, JSON.stringify({ workspace: f.workspace }));
  await f.engine.call('flow', { chatId: 'chat-1', mode: 'off' });
  await f.engine.call('flow', { chatId: 'manual-chat', mode: 'manual' });
  await f.engine.close();
  const restarted = await new Engine(await loadConfig(f.config.configFile), f.backend).init();
  try {
    assert.equal(restarted.modeFor('chat-1'), 'off');
    assert.equal(restarted.modeFor('manual-chat'), 'manual');
    assert.equal(restarted.modeFor('new-chat'), 'auto');
  } finally { await restarted.close(); }
});

test('general extraction stays staged until independent review; metrics distinguish plan estimates', async t => {
  const f = await fixture(t, proposal([], '{"requirements":["SSO","CSV"]}'), {
    models: { profiles: { 'worker:latest': { contextTokens: 32768 } } }
  });
  const task = await f.submit({ checks: [{ kind: 'json_schema', target: '$text', schema: {
    type: 'object', required: ['requirements'], properties: { requirements: { type: 'array', minItems: 2 } }
  } }] });
  await f.engine.idle();
  const request = f.backend.calls[0];
  const payload = JSON.parse(request.messages[1].content);
  assert.equal(payload.delivery, 'inline_text');
  assert.ok(!Object.hasOwn(payload, 'inputs') && !Object.hasOwn(payload, 'allowedOutputs'));
  assert.equal(request.contextTokens, 32768);
  assert.equal(f.engine.task(task).status, 'awaiting_review');
  assert.equal(f.engine.stats().acceptedResponses, 0);
  await f.engine.call('review', { taskId: task.taskId, decision: 'accept', evidence: 'Compared both requirements to the supplied brief.' });
  const stats = f.engine.stats();
  assert.equal(stats.localRequests, 1);
  assert.equal(stats.localInputTokens, 100);
  assert.equal(stats.localOutputTokens, 200);
  assert.equal(stats.generationTokensPerMinute, 6000);
  assert.equal(stats.allocation.plannedLocalPercent, 75);
  assert.equal(stats.allocation.completedLocalPercentOfPlan, 75);
  assert.equal(stats.codexTokens, null);
  assert.equal(stats.tokenSavings, null);
  await f.engine.call('complete_step', { chatId: 'chat-1', stepId: 'review-1', evidence: 'Source review completed.' });
  assert.equal(f.engine.stats().allocation.completedCodexPercentOfPlan, 25);
});

test('file writes require acceptance and application as separate operations', async t => {
  const f = await fixture(t, proposal([{ op: 'write', path: 'note.md', content: 'Validated brief\n' }]));
  const task = await f.submit({ allowedOutputs: ['note.md'] });
  await f.engine.idle();
  await assert.rejects(fs.stat(path.join(f.workspace, 'note.md')), { code: 'ENOENT' });
  await assert.rejects(f.engine.call('apply', { taskId: task.taskId }), /Review and accept/);
  await f.engine.call('review', { taskId: task.taskId, decision: 'accept', evidence: 'Reviewed the full proposed brief.' });
  assert.equal(f.engine.stats().allocation.completedLocalPercentOfPlan, 0);
  await f.engine.call('apply', { taskId: task.taskId });
  assert.equal(await fs.readFile(path.join(f.workspace, 'note.md'), 'utf8'), 'Validated brief\n');
  assert.equal(f.engine.stats().allocation.completedLocalPercentOfPlan, 75);
});

test('changed proposal bytes are refused when read, accepted, or applied', async t => {
  const f = await fixture(t, proposal([{ op: 'write', path: 'note.txt', content: 'Reviewed' }]));
  const { taskId } = await f.submit({ allowedOutputs: ['note.txt'] });
  await f.engine.idle();
  const artifact = path.join(f.config.stateDir, taskId, 'proposal.json');
  const original = await fs.readFile(artifact, 'utf8');
  const tampered = original.replace('Reviewed', 'Unreviewed');
  const review = { taskId, decision: 'accept', evidence: 'Read the original proposal.' };

  await fs.writeFile(artifact, tampered);
  await assert.rejects(f.engine.call('artifact', { taskId, artifact: 'proposal' }), /proposal changed/);
  await assert.rejects(f.engine.call('review', review), /proposal changed/);
  assert.equal(f.engine.task({ taskId }).status, 'awaiting_review');

  await fs.writeFile(artifact, original);
  await f.engine.call('review', review);
  await fs.writeFile(artifact, tampered);
  await assert.rejects(f.engine.call('apply', { taskId }), /proposal changed/);
  await assert.rejects(fs.stat(path.join(f.workspace, 'note.txt')), { code: 'ENOENT' });
  assert.equal(f.engine.task({ taskId }).status, 'accepted');
});

test('legacy jobs recover the proposal digest from the saved model response', async t => {
  const f = await fixture(t, proposal([{ op: 'write', path: 'note.txt', content: 'Original' }]));
  const { taskId } = await f.submit({ allowedOutputs: ['note.txt'] });
  await f.engine.idle();
  const job = f.engine.job(taskId);
  delete job.proposalSha256;
  const responseFile = path.join(f.config.stateDir, taskId, 'response.json');
  const originalResponse = await fs.readFile(responseFile);
  const review = { taskId, decision: 'accept', evidence: 'Read the legacy proposal.' };

  await fs.writeFile(responseFile, 'invalid');
  await assert.rejects(f.engine.call('review', review), /Cannot verify the original proposal/);
  await fs.writeFile(responseFile, originalResponse);
  await f.engine.call('review', review);
  assert.match(job.proposalSha256, /^[0-9a-f]{64}$/);

  // Simulate a proposal already accepted before the upgrade.
  delete job.proposalSha256;
  await f.engine.call('apply', { taskId });
  assert.equal(await fs.readFile(path.join(f.workspace, 'note.txt'), 'utf8'), 'Original');
});

test('changed source inputs prevent applying a now-stale proposal', async t => {
  const f = await fixture(t, proposal([{ op: 'write', path: 'out.txt', content: 'Derived' }]));
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'Original');
  const task = await f.submit({ inputs: [{ path: 'source.txt' }], allowedOutputs: ['out.txt'] });
  await f.engine.idle();
  await f.engine.call('review', { taskId: task.taskId, decision: 'accept', evidence: 'Read source and proposal.' });
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'New facts');
  await assert.rejects(f.engine.call('apply', { taskId: task.taskId }), /changed since submission/);
  await assert.rejects(fs.stat(path.join(f.workspace, 'out.txt')), { code: 'ENOENT' });
  await f.engine.call('review', { taskId: task.taskId, decision: 'reject', evidence: 'Withdrawing stale proposal after source update.' });
  const replacement = await f.submit({ inputs: [{ path: 'source.txt' }], allowedOutputs: ['out.txt'] });
  assert.ok(replacement.taskId);
});

test('user edits to an output are preserved', async t => {
  const f = await fixture(t, proposal([{ op: 'write', path: 'note.txt', content: 'Worker' }]));
  await fs.writeFile(path.join(f.workspace, 'note.txt'), 'Before');
  const task = await f.submit({ allowedOutputs: ['note.txt'] });
  await f.engine.idle();
  await f.engine.call('review', { taskId: task.taskId, decision: 'accept', evidence: 'Reviewed proposed change.' });
  await fs.writeFile(path.join(f.workspace, 'note.txt'), 'User edit');
  await assert.rejects(f.engine.call('apply', { taskId: task.taskId }), /changed since submission/);
  assert.equal(await fs.readFile(path.join(f.workspace, 'note.txt'), 'utf8'), 'User edit');
});

test('out-of-scope worker writes are rejected and counted with their tokens', async t => {
  const f = await fixture(t, proposal([{ op: 'write', path: 'other.txt', content: 'Bad' }]));
  const task = await f.submit({ allowedOutputs: ['expected.txt'] });
  await f.engine.idle();
  assert.equal(f.engine.task(task).status, 'invalid_response');
  assert.equal(f.engine.stats().rejectedResponses, 1);
  assert.equal(f.engine.stats().localOutputTokens, 200);
  await assert.rejects(fs.stat(path.join(f.workspace, 'other.txt')), { code: 'ENOENT' });
});

test('failed deterministic checks cannot be accepted', async t => {
  const f = await fixture(t);
  const task = await f.submit({ checks: [{ kind: 'contains', target: '$text', value: 'Missing requirement' }] });
  await f.engine.idle();
  assert.equal(f.engine.task(task).status, 'validation_failed');
  await assert.rejects(f.engine.call('review', { taskId: task.taskId, decision: 'accept', evidence: 'Ignore failure' }), /awaiting_review/);
});

test('oversize input asks for splitting without a model request', async t => {
  const f = await fixture(t, proposal(), { models: { profiles: { 'worker:latest': { contextTokens: 8192 } } } });
  const result = await f.submit({ context: 'é'.repeat(5000) });
  assert.equal(result.status, 'needs_split');
  assert.equal(result.budget.maxContextTokens, 8192);
  assert.equal(f.backend.calls.length, 0);
  assert.equal(f.engine.stats().localRequests, 0);
});

test('runtime context starts at the configured floor and grows while reserving response space', async t => {
  const windows = [];
  const cases = [
    { length: 0, floor: 32768 },
    { length: 9000, floor: 16384 },
    { length: 20000, floor: 16384 },
    { length: 30000, instructionLength: 10000, floor: 32768 }
  ];
  for (const entry of cases) {
    const settings = entry.length === 0 ? {} : { limits: { minContextTokens: entry.floor } };
    const f = await fixture(t, proposal(), settings);
    f.backend.models = async () => [{ ...names[0], maxContextTokens: 65536 }];
    const task = await f.submit({ context: 'x'.repeat(entry.length), instruction: 'x'.repeat(entry.instructionLength || 20) });
    await f.engine.idle();
    assert.equal(task.status, 'queued');
    assert.equal(task.budget.minContextTokens, entry.floor);
    assert.equal(task.budget.maxContextTokens, 65536);
    assert.ok(task.budget.contextTokens >= entry.floor);
    assert.ok(task.budget.requiredContextTokens <= task.budget.contextTokens);
    assert.ok(task.budget.estimatedInputTokens <= task.budget.promptBudget);
    assert.equal(f.backend.calls[0].contextTokens, task.budget.contextTokens);
    windows.push(task.budget.contextTokens);
  }
  assert.equal(windows[0], 32768);
  assert.equal(windows[1], 16384);
  assert.ok(windows[2] > windows[1]);
  assert.ok(windows[3] > windows[0] && windows[3] <= 65536);
});

test('adaptive context honors the per-model profile and reported model capacity', async t => {
  const profiled = await fixture(t, proposal(), { models: { profiles: { 'worker:latest': { contextTokens: 8192 } } } });
  const bounded = await profiled.submit({ context: 'x'.repeat(9000) });
  assert.equal(bounded.status, 'needs_split');
  assert.equal(bounded.budget.maxContextTokens, 8192);
  assert.equal(profiled.backend.calls.length, 0);

  const smaller = await fixture(t, proposal(), { limits: { minContextTokens: 16384 } });
  smaller.backend.models = async () => [{ ...names[0], maxContextTokens: 12288 }];
  const capped = await smaller.submit({ context: 'x'.repeat(9000) });
  assert.equal(capped.status, 'needs_split');
  assert.equal(capped.budget.contextTokens, 12288);
  assert.equal(capped.budget.maxContextTokens, 12288);
  assert.equal(smaller.backend.calls.length, 0);
});

test('a task beyond reported model capacity asks for splitting before inference', async t => {
  const f = await fixture(t);
  const result = await f.submit({ context: 'x'.repeat(30000), instruction: 'x'.repeat(10000) });
  assert.equal(result.status, 'needs_split');
  assert.equal(result.budget.contextTokens, 32768);
  assert.ok(result.budget.requiredContextTokens > result.budget.maxContextTokens);
  assert.equal(f.backend.calls.length, 0);
});

test('legacy context settings supply a floor when model capacity is unknown', async t => {
  const f = await fixture(t, proposal(), { limits: { contextTokens: 16384 } });
  assert.equal(f.config.limits.minContextTokens, 16384);
  f.backend.models = async () => [{ ...names[0], maxContextTokens: null }];
  const task = await f.submit({ context: 'x'.repeat(30000), instruction: 'x'.repeat(10000) });
  await f.engine.idle();
  assert.equal(task.status, 'queued');
  assert.equal(task.budget.maxContextTokens, null);
  assert.ok(task.budget.contextTokens > 32768);
  assert.ok(task.budget.requiredContextTokens <= task.budget.contextTokens);
  assert.equal(f.backend.calls[0].contextTokens, task.budget.contextTokens);
});

test('line ranges send only selected source context', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'secret-not-needed\nrelevant-fact\nother-fact');
  await f.submit({ inputs: [{ path: 'source.txt', startLine: 2, endLine: 2 }] });
  await f.engine.idle();
  const content = f.backend.calls[0].messages[1].content;
  assert.ok(content.includes('relevant-fact'));
  assert.ok(!content.includes('secret-not-needed'));
});

test('move proposals can sort a binary file without feeding its bytes to the model', async t => {
  const f = await fixture(t, proposal([{ op: 'move', from: 'scan.bin', to: 'archive/scan.bin' }]));
  const bytes = Buffer.from([0, 1, 2, 255]);
  const source = path.join(f.config.workspace, 'scan.bin');
  const destination = path.join(f.config.workspace, 'archive/scan.bin');
  await fs.writeFile(source, bytes);
  const task = await f.submit({ context: 'Classify scan.bin in archive.', allowedOutputs: ['scan.bin', 'archive/scan.bin'] });
  await f.engine.idle();
  await f.engine.call('review', { taskId: task.taskId, decision: 'accept', evidence: 'Verified classification and destination.' });
  const unlink = fs.unlink;
  const unlinkSpy = t.mock.method(fs, 'unlink', async file => {
    if (file === source) assert.deepEqual(await fs.readFile(destination), bytes);
    return unlink(file);
  });
  await f.engine.call('apply', { taskId: task.taskId });
  assert.ok(unlinkSpy.mock.calls.some(call => call.arguments[0] === source));
  assert.deepEqual(await fs.readFile(destination), bytes);
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
});

test('sorting refuses an existing destination', async t => {
  const f = await fixture(t, proposal([{ op: 'move', from: 'one.txt', to: 'two.txt' }]));
  await fs.writeFile(path.join(f.workspace, 'one.txt'), 'one');
  await fs.writeFile(path.join(f.workspace, 'two.txt'), 'two');
  const task = await f.submit({ allowedOutputs: ['one.txt', 'two.txt'] });
  await f.engine.idle();
  assert.equal(f.engine.task(task).status, 'invalid_response');
  assert.equal(await fs.readFile(path.join(f.workspace, 'two.txt'), 'utf8'), 'two');
});

test('a move preserves the source if another writer wins the destination', async t => {
  const f = await fixture(t, proposal([{ op: 'move', from: 'one.txt', to: 'two.txt' }]));
  const source = path.join(f.config.workspace, 'one.txt');
  const destination = path.join(f.config.workspace, 'two.txt');
  await fs.writeFile(source, 'one');
  const { taskId } = await f.submit({ allowedOutputs: ['one.txt', 'two.txt'] });
  await f.engine.idle();
  await f.engine.call('review', { taskId, decision: 'accept', evidence: 'Checked the destination.' });
  const link = fs.link;
  t.mock.method(fs, 'link', async (temporary, target) => {
    if (target === destination) await fs.writeFile(target, 'Other writer', { flag: 'wx' });
    return link(temporary, target);
  });
  await assert.rejects(f.engine.call('apply', { taskId }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(source, 'utf8'), 'one');
  assert.equal(await fs.readFile(destination, 'utf8'), 'Other writer');
  assert.deepEqual((await fs.readdir(f.workspace)).sort(), ['.local-ai', 'one.txt', 'two.txt']);
});

test('paths block traversal, secrets, NTFS streams and Windows aliases', async t => {
  const f = await fixture(t);
  for (const name of ['../escape', '.git/config', '.env', '.env.prod', 'local-ai.config.json', 'local-ai.config.json.tmp',
    '.local-ai-write-example', 'a:stream', 'CON.txt', 'a./b', 'x\\y', '/absolute']) {
    await assert.rejects(f.engine.workspace.resolve(name), undefined, name);
  }
});

test('junction context cannot escape the configured workspace', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'not sent');
  await fs.symlink(outside, path.join(f.workspace, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.engine.workspace.readContext({ path: 'redirect/secret.txt' }), /link|junction/);
});

test('hardlinked source files are rejected', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspace, 'a.txt'), 'a');
  await fs.link(path.join(f.workspace, 'a.txt'), path.join(f.workspace, 'b.txt'));
  await assert.rejects(f.engine.workspace.snapshot('b.txt'), /unlinked/);
});

test('a later application failure restores an earlier file', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspace, 'a.txt'), 'before');
  const ws = new Workspace(f.config);
  const baseline = { 'a.txt': (await ws.snapshot('a.txt')).sha256, 'b.txt': null };
  const originalSnapshot = ws.snapshot.bind(ws);
  let bReads = 0;
  ws.snapshot = async name => {
    if (name === 'b.txt' && ++bReads === 2) throw new Error('Simulated late IO failure');
    return originalSnapshot(name);
  };
  await assert.rejects(ws.apply(new Map([['a.txt', Buffer.from('after')], ['b.txt', Buffer.from('b')]]), baseline), /late IO failure/);
  assert.equal(await fs.readFile(path.join(f.workspace, 'a.txt'), 'utf8'), 'before');
});

test('model selection uses explicit, type, default and unique model, and refuses ambiguity', () => {
  const models = [...names, { name: 'other', capabilities: ['completion'] }, { name: 'embed', capabilities: ['embedding'] },
    { name: 'upstream', capabilities: ['completion'], remote: true }];
  const prefs = { default: 'worker:latest', byTask: { writing: 'other' } };
  assert.equal(chooseModel(models, prefs, 'writing', 'worker:latest').name, 'worker:latest');
  assert.equal(chooseModel(models, prefs, 'writing').name, 'other');
  assert.equal(chooseModel(models, prefs, 'data').name, 'worker:latest');
  assert.equal(chooseModel(names, { byTask: {} }, 'data').name, 'worker:latest');
  assert.throws(() => chooseModel(models, { byTask: {} }, 'data'), /Choose a model/);
  assert.throws(() => chooseModel(models, prefs, 'data', 'embed'), /unavailable/);
  assert.throws(() => chooseModel(models, prefs, 'data', 'missing'), /unavailable/);
  assert.throws(() => chooseModel(models, prefs, 'data', 'upstream'), /unavailable/);
});

test('model preferences are persisted without losing the workspace setting', async t => {
  const f = await fixture(t);
  await f.engine.call('preferences', { default: 'worker:latest', byTask: { presales: 'worker:latest' }, profiles: { 'worker:latest': { contextTokens: 4096, think: false } } });
  const config = await loadConfig(f.config.configFile);
  assert.equal(config.workspace, f.config.workspace);
  assert.equal(config.models.byTask.presales, 'worker:latest');
  assert.equal(config.models.profiles['worker:latest'].think, false);
});

test('state and preferences never write through pre-existing temporary links', async t => {
  const f = await fixture(t);
  const sentinel = path.join(f.root, 'sentinel.txt');
  await fs.writeFile(sentinel, 'Keep these bytes');
  await fs.link(sentinel, path.join(f.config.stateDir, 'state.json.tmp'));
  await fs.link(sentinel, f.config.configFile + '.tmp');

  await f.engine.call('flow', { chatId: 'chat-1', mode: 'auto' });
  await f.engine.call('preferences', { default: 'worker:latest' });
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'Keep these bytes');
  const state = JSON.parse(await fs.readFile(path.join(f.config.stateDir, 'state.json'), 'utf8'));
  assert.equal(state.modes['chat-1'], 'auto');
  assert.equal((await loadConfig(f.config.configFile)).models.default, 'worker:latest');
});

test('worker requests for context remain pending work rather than accepted work', async t => {
  const f = await fixture(t, { ...proposal(), status: 'needs_context', summary: 'Need source pricing.' });
  const task = await f.submit();
  await f.engine.idle();
  assert.equal(f.engine.task(task).status, 'needs_context');
  assert.equal(f.engine.stats().acceptedResponses, 0);
  assert.equal(f.engine.stats().needsContextResponses, 1);
  assert.equal(f.engine.stats().allocation.completedSteps, 0);
});

test('host cancellation stops local work without an acceptance verdict', async t => {
  const f = await fixture(t);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.backend.generate = async (_, signal) => {
    started();
    return new Promise((resolve, reject) => {
      if (signal.aborted) reject(new Error('Aborted'));
      else signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
  };
  const task = await f.submit();
  await ready;
  await f.engine.call('cancel', { taskId: task.taskId });
  await f.engine.idle();
  assert.equal(f.engine.task(task).status, 'cancelled');
  assert.equal(f.engine.stats().requestsWithoutInputTokenCounts, 1);
  assert.equal(f.engine.stats().rejectedResponses, 0);
});

test('rejected proposals cannot be applied, and repeated reviews do not inflate metrics', async t => {
  const f = await fixture(t);
  const task = await f.submit();
  await f.engine.idle();
  await f.engine.call('review', { taskId: task.taskId, decision: 'reject', evidence: 'Requirement missing.' });
  await assert.rejects(f.engine.call('review', { taskId: task.taskId, decision: 'reject', evidence: 'Again' }), /awaiting_review/);
  await assert.rejects(f.engine.call('apply', { taskId: task.taskId }), /Review and accept/);
  assert.equal(f.engine.stats().rejectedResponses, 1);
});

test('truncated generation and excess observed context are rejected', async t => {
  const f = await fixture(t);
  f.backend.generate = async () => ({ done_reason: 'length', message: { content: '{}' }, eval_count: 50 });
  const first = await f.submit();
  await f.engine.idle();
  assert.equal(f.engine.task(first).status, 'invalid_response');
  assert.match(f.engine.task(first).error, /Output token limit/);
  f.backend.generate = async input => ({ message: { content: JSON.stringify(proposal()) }, prompt_eval_count: input.contextTokens });
  const second = await f.submit();
  await f.engine.idle();
  assert.match(f.engine.task(second).error, /Observed prompt/);
});

test('artifact reads are bounded and arbitrary artifact paths are rejected', async t => {
  const f = await fixture(t, proposal([], 'a'.repeat(9000)));
  const task = await f.submit();
  await f.engine.idle();
  const part = await f.engine.call('artifact', { taskId: task.taskId, artifact: 'proposal', length: 100 });
  assert.equal(part.content.length, 100);
  assert.equal(part.nextOffset, 100);
  await assert.rejects(f.engine.call('artifact', { taskId: task.taskId, artifact: '../config' }));
});

test('second writable host is refused; state survives an orderly restart', async t => {
  const f = await fixture(t);
  await assert.rejects(new Engine(f.config, f.backend).init(), /already using/);
  const task = await f.submit();
  await f.engine.idle();
  await f.engine.close();
  const next = await new Engine(f.config, f.backend).init();
  try { assert.equal(next.task(task).status, 'awaiting_review'); }
  finally { await next.close(); }
});

test('missing usage is not manufactured and zero generation duration has no speed', () => {
  const usage = usageFrom({}, 8192, 10);
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.outputTokens, null);
  assert.equal(usage.generationTokensPerMinute, null);
  assert.equal(usage.observedPromptFillPercent, null);
  assert.equal(usageFrom({ eval_count: 5, eval_duration: 0 }, 100, 10).generationTokensPerMinute, null);
});
