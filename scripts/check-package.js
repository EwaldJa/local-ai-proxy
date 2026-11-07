// Development-only: fetch the canonical public schemas, never a plugin startup step.
import fs from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';

const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const name of ['plugin', 'mcp']) {
  const url = `https://agent-plugins.org/schemas/1.0.0/${name}.schema.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Schema request: HTTP ${response.status}`);
  const validate = ajv.compile(await response.json());
  const value = JSON.parse(await fs.readFile(`${name}.json`, 'utf8'));
  if (!validate(value)) throw new Error(`${name}.json: ${ajv.errorsText(validate.errors)}`);
  console.log(`${name}.json: canonical schema valid`);
}
await fs.stat('skills/local-delegate/SKILL.md');
