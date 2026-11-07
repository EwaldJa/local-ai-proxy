import fs from 'node:fs/promises';
import path from 'node:path';

export async function lockState(stateDir) {
  const file = path.join(stateDir, 'host.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.close();
      return async () => fs.unlink(file);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const { pid } = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid host.lock; inspect it before removing it.');
      try { process.kill(pid, 0); }
      catch (error) {
        if (error.code !== 'ESRCH') throw error;
        await fs.unlink(file);
        continue;
      }
      throw new Error('A host is already using this workspace. Use its MCP tools; CLI stats remains available.');
    }
  }
  throw new Error('Cannot acquire workspace host lock');
}
