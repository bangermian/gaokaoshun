/** 生成 data/index.json —— 静态托管时的自动加载清单 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const outFile = process.argv[3] || path.join(dir, 'index.json');
if (!dir) { console.error('用法: node gen-index.mjs <data目录>'); process.exit(1); }

const SKIP = /^(软科|schools|README)/i;
const OK_EXT = /\.(xlsx|xls|csv)$/i;

const files = [];
function walk(current, relBase) {
  for (const name of fs.readdirSync(current)) {
    const full = path.join(current, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) { walk(full, relBase ? `${relBase}/${name}` : name); continue; }
    if (!OK_EXT.test(name) || SKIP.test(name)) continue;
    if (name.endsWith('.bak')) continue;
    const rel = relBase ? `${relBase}/${name}` : name;
    files.push({ rel, size: st.size, mtime: Math.round(st.mtimeMs) });
  }
}
walk(dir, '');
files.sort((a, b) => a.rel.localeCompare(b.rel));

const signature = `${files.length}:${files.reduce((n, f) => n + f.size, 0)}:${Math.max(0, ...files.map((f) => f.mtime))}`;
const out = { files, signature };
fs.writeFileSync(outFile, JSON.stringify(out), 'utf8');
console.log(`生成 ${path.join(dir, 'index.json')}：${files.length} 个文件`);
for (const f of files) console.log(`  ${f.rel}  ${(f.size / 1024).toFixed(0)} KB`);
