import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { chatStateDir } from './config.js';
import { Engine } from './engine.js';

const resourceUri = 'ui://local-ai-proxy/delegation-status.html';
const mimeType = 'text/html;profile=mcp-app';
// Tool titles are registered before the UI receives the host's locale.
const panelTitle = Intl.DateTimeFormat().resolvedOptions().locale.startsWith('fr')
  ? 'Délégation modèle local' : 'Local LLM delegation';
const recentRequestLimit = 20;
const taskIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function rejectionReason(reader, job) {
  if (job.verdict !== 'rejected') return null;
  if (job.status === 'invalid_response') return job.error || null;
  if (job.status === 'validation_failed') {
    const failed = job.checks?.find(check => !check.passed);
    if (!failed?.error) return 'Échec d’une vérification automatique.';
    return failed.target ? `${failed.target} · ${failed.error}` : failed.error;
  }
  if (job.status !== 'rejected' || !taskIdPattern.test(job.id)) return null;
  try {
    const review = JSON.parse(await reader.artifactRead(job.id, 'review'));
    if (review?.decision === 'reject' && typeof review.evidence === 'string') return review.evidence.trim() || null;
  } catch {
    // Missing or unreadable evidence must not hide the request history.
  }
  return null;
}

function recentRequests(reader, chatId) {
  const { state } = reader;
  const steps = Object.hasOwn(state.sessions, chatId) ? state.sessions[chatId].steps : [];
  const titles = new Map(steps.map(step => [step.id, step.title]));
  const jobs = Object.values(state.jobs)
    .filter(job => job.chatId === chatId && job.modelCalls > 0)
    .slice(-recentRequestLimit).reverse();
  return Promise.all(jobs.map(async job => {
    const started = Date.parse(job.startedAt);
    const ended = job.status === 'running' ? Date.now() : Date.parse(job.finishedAt);
    const durationMs = job.usage?.wallMs ?? (Number.isFinite(started) && Number.isFinite(ended) ? ended - started : null);
    return {
      title: titles.get(job.stepId) || job.stepId,
      preview: job.instructionPreview || null,
      model: job.model || null,
      // Keep the window requested for this call, independently of later settings.
      contextTokens: job.budget?.contextTokens ?? job.usage?.requestedContextTokens ?? null,
      status: job.status,
      verdict: job.verdict,
      rejectionReason: await rejectionReason(reader, job),
      startedAt: Number.isFinite(started) ? job.startedAt : null,
      inputTokens: job.usage?.inputTokens ?? null,
      outputTokens: job.usage?.outputTokens ?? null,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null
    };
  }));
}

export function codexChatId(ctx) {
  const metadata = ctx.mcpReq._meta;
  const id = metadata?.threadId ?? metadata?.thread_id;
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : null;
}

export function registerStatusPanel(server, config, { onPanelRequested = () => {} } = {}) {
  server.registerResource('delegation-status', resourceUri, {
    title: panelTitle, mimeType
  }, async () => ({ contents: [{ uri: resourceUri, mimeType,
    _meta: { 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] } },
    text: await fs.readFile(new URL('./ui/delegation-status.html', import.meta.url), 'utf8')
  }] }));

  async function snapshot(_input, ctx) {
    try {
      const chatId = codexChatId(ctx);
      if (!chatId) throw new Error('Ouvre le panneau depuis un chat Codex pour afficher ses compteurs.');

      // Read the atomic snapshot directly so opening the panel takes no writer lock.
      const stateDir = chatStateDir(config, chatId);
      const reader = new Engine(config, undefined, stateDir);
      const stateFile = path.join(stateDir, 'state.json');
      try { reader.state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const stats = reader.stats({ chatId });
      const status = {
        mode: reader.modeFor(chatId),
        localRequests: stats.localRequests,
        localInputTokens: stats.localInputTokens,
        localOutputTokens: stats.localOutputTokens,
        acceptedResponses: stats.acceptedResponses,
        rejectedResponses: stats.rejectedResponses,
        awaitingReview: stats.awaitingReview,
        needsContextResponses: stats.needsContextResponses,
        generationTokensPerMinute: stats.generationTokensPerMinute,
        lastContext: stats.lastContext,
        recentRequests: await recentRequests(reader, chatId)
      };
      return { structuredContent: status, content: [{ type: 'text', text: JSON.stringify(status) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  }

  const options = {
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  };
  server.registerTool('local_status_panel', {
    ...options, title: panelTitle,
    description: 'Display the current chat’s delegation controls and usage counters, even before any local request. Call once when local_flow returns statusPanel.action open, or when the user asks to see the panel. The UI requests an expanded tab automatically.',
    _meta: { ui: { resourceUri, visibility: ['model', 'app'] }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } }
  }, async (input, ctx) => {
    const result = await snapshot(input, ctx);
    if (!result.isError) onPanelRequested(codexChatId(ctx));
    return result;
  });
  server.registerTool('local_status_snapshot', {
    ...options, description: 'Refresh the delegation status panel for the current chat.',
    _meta: { ui: { visibility: ['app'] } }
  }, snapshot);
}
