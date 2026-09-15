import { build } from 'esbuild';
import { mkdir,copyFile,chmod } from 'node:fs/promises';
await mkdir('dist',{recursive:true});
const shared={bundle:true,format:'esm',platform:'node',target:'node22',logLevel:'warning'};
await build({...shared,entryPoints:['../../worker/src/lib/measurement-core/index.ts'],outfile:'dist/core.mjs'});
await build({...shared,entryPoints:['src/adapters.ts'],outfile:'dist/adapters.mjs'});
for(const name of ['sync','cli','observer','observer-contract'])await copyFile(`src/${name}.mjs`,`dist/${name}.mjs`);
await chmod('dist/cli.mjs',0o755);
