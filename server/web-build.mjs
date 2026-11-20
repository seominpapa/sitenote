import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const serverInput = name => name.endsWith('.mjs') || name === 'package.json' || name === 'package-lock.json';

export function webBuild(index, serverDir) {
  const hash = createHash('sha256').update(index);
  for (const name of readdirSync(serverDir).filter(serverInput).sort()) {
    hash.update(name).update('\0').update(readFileSync(join(serverDir, name))).update('\0');
  }
  return hash.digest('hex');
}
