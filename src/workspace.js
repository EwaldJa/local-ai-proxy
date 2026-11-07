import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomically } from './atomic-file.js';

export const digest = data => createHash('sha256').update(data).digest('hex');
const protectedPart = part => /^(\.git|\.local-ai|\.agents|\.codex|\.aws|node_modules)$/i.test(part)
  || /^\.env($|\.)/i.test(part) || /^\.local-ai-write-/i.test(part)
  || /^(local-ai\.config\.json(\.tmp)?|id_rsa|id_ed25519)$/i.test(part)
  || /\.(pem|key|pfx|p12)$/i.test(part);

async function writeWorkspaceFile(full, bytes, isNew) {
  const mode = isNew ? 0o600 : (await fs.stat(full)).mode;
  await writeFileAtomically(full, bytes, { mode, noClobber: isNew });
}

export class Workspace {
  constructor(config) { this.config = config; this.root = config.workspace; }

  async resolve(relative) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0')) {
      throw new Error('Use a workspace-relative path with forward slashes.');
    }
    const parts = relative.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || protectedPart(p) || /[. ]$/.test(p)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) throw new Error(`Protected or invalid path: ${relative}`);
    const full = path.resolve(this.root, relative);
    const rel = path.relative(this.root, full);
    if (path.isAbsolute(rel) || rel.startsWith('..')) throw new Error('Path outside workspace');
    let current = this.root;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error(`Symbolic link/junction refused: ${relative}`);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return full;
  }

  async snapshot(relative) {
    const full = await this.resolve(relative);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Expected a regular, unlinked file: ${relative}`);
      if (stat.size > this.config.limits.maxFileBytes) throw new Error(`File too large: ${relative}`);
      const content = await fs.readFile(full);
      return { path: relative, sha256: digest(content), content };
    } catch (e) { if (e.code === 'ENOENT') return { path: relative, sha256: null, content: null }; throw e; }
  }

  async readContext(input) {
    const snapshot = await this.snapshot(input.path);
    if (snapshot.content === null) throw new Error(`Context file missing: ${input.path}`);
    if (snapshot.content.includes(0)) throw new Error(`Binary context needs a format adapter: ${input.path}`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.content);
    const lines = text.split(/\r?\n/);
    const start = input.startLine || 1;
    const end = input.endLine || lines.length;
    if (start < 1 || end < start || end > lines.length) throw new Error(`Invalid line range: ${input.path}`);
    return { path: input.path, sha256: snapshot.sha256, startLine: start, endLine: end,
      content: lines.slice(start - 1, end).join('\n') };
  }

  async prepare(changes, allowedPaths) {
    const allowed = new Set(allowedPaths);
    const desired = new Map();
    const touched = new Set();
    const register = name => {
      if (!allowed.has(name)) throw new Error(`Output outside task scope: ${name}`);
      if (touched.has(name.toLowerCase())) throw new Error(`Overlapping output path: ${name}`);
      touched.add(name.toLowerCase());
    };
    for (const change of changes) {
      if (change.op === 'write') {
        register(change.path);
        const bytes = Buffer.from(change.content, 'utf8');
        if (bytes.length > this.config.limits.maxFileBytes) throw new Error('Output file too large');
        desired.set(change.path, bytes);
      } else if (change.op === 'move') {
        register(change.from); register(change.to);
        const source = await this.snapshot(change.from);
        const target = await this.snapshot(change.to);
        if (source.content === null || target.content !== null) throw new Error('Move needs an existing source and an absent destination');
        desired.set(change.from, null); desired.set(change.to, source.content);
      } else throw new Error('Unsupported file operation');
    }
    return desired;
  }

  async apply(desired, baseline) {
    const before = new Map();
    for (const name of desired.keys()) {
      const current = await this.snapshot(name);
      if (!Object.hasOwn(baseline, name) || current.sha256 !== baseline[name]) throw new Error(`File changed since submission: ${name}`);
      before.set(name, current.content);
    }
    // Publish every move destination before removing any source. An interrupted
    // process may leave a duplicate, but a source never disappears first.
    const entries = [...desired];
    const writes = entries.filter(([, bytes]) => bytes !== null);
    const removals = entries.filter(([, bytes]) => bytes === null);
    const written = [];
    try {
      for (const [name, bytes] of [...writes, ...removals]) {
        const full = await this.resolve(name);
        // Recheck immediately before writing; a filesystem sandbox is still required
        // against a malicious process racing these checks.
        if ((await this.snapshot(name)).sha256 !== baseline[name]) throw new Error(`Concurrent edit: ${name}`);
        if (bytes === null) await fs.unlink(full);
        else {
          await fs.mkdir(path.dirname(full), { recursive: true });
          await writeWorkspaceFile(full, bytes, before.get(name) === null);
        }
        written.push(name);
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const name of written.reverse()) {
        try {
          const full = await this.resolve(name);
          const bytes = before.get(name);
          const applied = desired.get(name);
          const current = await this.snapshot(name);
          // Preserve edits made after publication, even when rollback is needed.
          if (current.sha256 !== (applied === null ? null : digest(applied))) throw new Error('File changed during rollback');
          if (bytes === null) await fs.unlink(full);
          else await writeWorkspaceFile(full, bytes, current.content === null);
          if ((await this.snapshot(name)).sha256 !== baseline[name]) throw new Error('Rollback digest mismatch');
        } catch (e) { rollbackErrors.push(`${name}: ${e.message}`); }
      }
      if (rollbackErrors.length) throw new Error(`Workspace state unknown: ${rollbackErrors.join('; ')}. Original error: ${error.message}`);
      throw error;
    }
    return [...desired.keys()];
  }
}
