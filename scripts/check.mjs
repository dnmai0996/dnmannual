import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
let count=0;
function scan(dir){for(const f of readdirSync(dir,{withFileTypes:true})){const p=join(dir,f.name);if(f.isDirectory())scan(p);else if(/\.(mjs|js)$/.test(f.name)){const r=spawnSync(process.execPath,['--check',p],{encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);count++;}}}
scan('public');scan('netlify/functions');scan('scripts');console.log(`Syntax check passed: ${count} files`);
const html=readFileSync('public/index.html','utf8');if(!html.includes('dnm-logo.png'))throw new Error('Logo missing');
