import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeFileAtomically(file, content, { mode = 0o600, noClobber = false } = {}) {
  const temporary = path.join(path.dirname(file), `.local-ai-write-${randomUUID()}`);
  // An exclusive open makes the temporary file ours before we enter cleanup.
  const handle = await fs.open(temporary, 'wx', mode);
  let publishedByRename = false;
  try {
    try { await handle.writeFile(content); }
    finally { await handle.close(); }

    if (noClobber) {
      // Linking publishes a complete new file and fails if its name is taken.
      await fs.link(temporary, file);
    } else {
      await fs.rename(temporary, file);
      publishedByRename = true;
    }
  } finally {
    // Cleanup must preserve the outcome of the write or publication attempt.
    if (!publishedByRename) await fs.unlink(temporary).catch(() => {});
  }
}
