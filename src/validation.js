import Ajv from 'ajv';

const ajv = new Ajv({ strict: true, allErrors: true });
export const outputSchema = {
  type: 'object', additionalProperties: false,
  required: ['status', 'summary', 'text', 'changes'],
  properties: {
    status: { enum: ['completed', 'needs_context'] },
    summary: { type: 'string', maxLength: 2000 },
    text: { type: 'string' },
    changes: { type: 'array', maxItems: 50, items: { anyOf: [
      { type: 'object', additionalProperties: false, required: ['op', 'path', 'content'],
        properties: { op: { const: 'write' }, path: { type: 'string' }, content: { type: 'string' } } },
      { type: 'object', additionalProperties: false, required: ['op', 'from', 'to'],
        properties: { op: { const: 'move' }, from: { type: 'string' }, to: { type: 'string' } } }
    ] } }
  }
};
const validateOutput = ajv.compile(outputSchema);
export function parseOutput(content) {
  const result = JSON.parse(content);
  if (!validateOutput(result)) throw new Error(`Invalid local output: ${ajv.errorsText(validateOutput.errors)}`);
  return result;
}

export function validateChecks(checks, result, desired) {
  return checks.map(check => {
    try {
      const value = check.target === '$text' ? result.text : desired.get(check.target)?.toString('utf8');
      if (value === undefined) throw new Error('Check target missing from proposal');
      if (check.kind === 'contains' && !value.includes(check.value)) throw new Error('Required text missing');
      else if (check.kind === 'not_contains' && value.includes(check.value)) throw new Error('Forbidden text found');
      else if (check.kind === 'json_schema') {
        const validate = ajv.compile(check.schema);
        if (!validate(JSON.parse(value))) throw new Error(ajv.errorsText(validate.errors));
      } else if (!['contains', 'not_contains'].includes(check.kind)) throw new Error('Unknown check kind');
      return { ...check, passed: true };
    } catch (e) { return { ...check, passed: false, error: e.message }; }
  });
}
