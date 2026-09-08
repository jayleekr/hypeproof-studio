import * as fs from 'node:fs';
import * as path from 'node:path';

/** Only explicit course context can seed a web starter. Existing files are never replaced. */
export function prepareWorkspaceDirectory(dir: string, mode: 'empty' | 'html', starter: () => string): void {
  fs.mkdirSync(dir, {recursive:true});
  if (mode === 'empty') return;
  const target = path.join(dir,'index.html');
  try { fs.writeFileSync(target,starter(),{flag:'wx'}); }
  catch(error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
