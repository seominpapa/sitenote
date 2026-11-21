import { join } from 'node:path';
import { rolldown } from 'rolldown';

export async function buildDocumentConverter() {
  const desktop = import.meta.dirname;
  const build = await rolldown({input:join(desktop, '..', 'src', 'records', 'document-converter.cjs'), platform:'node'});
  try { await build.write({file:join(desktop, 'document-converter.bundle.cjs'), format:'cjs', comments:true}); }
  finally { await build.close(); }
}
