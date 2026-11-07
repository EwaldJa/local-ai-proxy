import * as z from 'zod/v4';

const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const file = z.string().min(1).max(500);
const check = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('contains'), target: file, value: z.string().max(10000) }).strict(),
  z.object({ kind: z.literal('not_contains'), target: file, value: z.string().max(10000) }).strict(),
  z.object({ kind: z.literal('json_schema'), target: file, schema: z.record(z.string(), z.unknown()) }).strict()
]);

export const schemas = {
  flow: z.object({ chatId: id, mode: z.enum(['auto', 'manual', 'off']).optional() }).strict(),
  models: z.object({}).strict(),
  preferences: z.object({
    default: z.string().max(200).nullable(),
    byTask: z.record(z.string().max(60), z.string().max(200)).default({}),
    profiles: z.record(z.string(), z.object({ contextTokens: z.number().int().positive().optional(),
      outputTokens: z.number().int().positive().optional(), think: z.union([z.boolean(), z.enum(['low', 'medium', 'high'])]).optional()
    }).strict()).default({})
  }).strict(),
  plan: z.object({ chatId: id, goal: z.string().min(1).max(3000), append: z.boolean().default(false),
    steps: z.array(z.object({ id, title: z.string().min(1).max(300), executor: z.enum(['local', 'codex']),
      taskType: z.string().min(1).max(60), weight: z.number().positive().max(100).default(1)
    }).strict()).min(1).max(200)
  }).strict(),
  complete_step: z.object({ chatId: id, stepId: id, evidence: z.string().min(1).max(2000) }).strict(),
  submit: z.object({ chatId: id, stepId: id,
    instruction: z.string().min(1).max(20000),
    context: z.string().max(30000).default(''),
    inputs: z.array(z.object({ path: file, startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional() }).strict()).max(50).default([]),
    allowedOutputs: z.array(file).max(50).default([]),
    acceptance: z.array(z.string().min(1).max(2000)).min(1).max(30),
    checks: z.array(check).max(100).default([]),
    model: z.string().max(200).optional()
  }).strict(),
  task: z.object({ taskId: id, waitMs: z.number().int().min(0).max(20000).default(0),
    proposalChars: z.number().int().min(0).max(8000).default(0) }).strict(),
  artifact: z.object({ taskId: id, artifact: z.enum(['request', 'response', 'proposal', 'checks', 'review']),
    offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(8000).default(2000)
  }).strict(),
  review: z.object({ taskId: id, decision: z.enum(['accept', 'reject']),
    evidence: z.string().min(1).max(4000) }).strict(),
  apply: z.object({ taskId: id }).strict(),
  cancel: z.object({ taskId: id }).strict(),
  stats: z.object({ chatId: id.optional() }).strict()
};
