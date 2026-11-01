#!/usr/bin/env node
/**
 * 把 data/软科评分.csv 注入成前端可直接用的模块：assets/js/ruanke.js
 *
 * 之所以"构建"而不是运行时读取：网站在纯静态托管下加载，多一个数据文件就多一次请求，
 * 而且 CSV 要和分数表抢解析流程。软科评分一共几百条，直接打进 JS 最省事。
 *
 * 用法：node tools/build-ruanke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', '软科评分.csv');
const OUT = path.join(ROOT, 'assets', 'js', 'ruanke.js');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const text = fs.readFileSync(SRC, 'utf8');
const rows = parseCsv(text);
const head = rows.shift();
const idx = (name) => head.indexOf(name);
const iYear = idx('年份');
const iRank = idx('软科排名');
const iName = idx('学校名称');
const iScore = idx('软科评分');
const iProv = idx('所在省份');

if (iName < 0 || iScore < 0 || iYear < 0) {
  console.error('✗ 软科评分.csv 列名不对，需要 年份/学校名称/软科评分');
  process.exit(1);
}

/** name → { 年份: { rank, score } } */
const map = {};
const years = new Set();
for (const r of rows) {
  const name = String(r[iName] ?? '').trim();
  const year = String(r[iYear] ?? '').trim();
  const score = Number(r[iScore]);
  const rank = Number(r[iRank]);
  if (!name || !year) continue;
  if (!Number.isFinite(score)) continue;
  years.add(year);
  if (!map[name]) map[name] = {};
  map[name][year] = { rank: Number.isFinite(rank) ? rank : null, score, province: String(r[iProv] ?? '').trim() };
}

const yearList = [...years].sort((a, b) => Number(b) - Number(a));
const lines = [
  '// 本文件由 tools/build-ruanke.mjs 自动生成，请勿手改',
  '// 数据来源：软科（ShanghaiRanking）中国大学排名，主榜评分',
  `// 覆盖 ${Object.keys(map).length} 所学校 · 年份 ${yearList.join('/')}`,
  '',
  `export const RUANKE_YEARS = ${JSON.stringify(yearList)};`,
  '',
  `export const RUANKE = ${JSON.stringify(map, null, 0)};`,
  '',
  '/** 取某校某年的软科评分；不传年份则取最新一年 */',
  'export function ruankeOf(name, year) {',
  '  const entry = RUANKE[name];',
  '  if (!entry) return null;',
  '  if (year != null && entry[year]) return { year: String(year), ...entry[year] };',
  '  for (const y of RUANKE_YEARS) {',
  '    if (entry[y]) return { year: y, ...entry[y] };',
  '  }',
  '  return null;',
  '}',
  '',
  '/** 某校的历年评分序列（升序） */',
  'export function ruankeSeries(name) {',
  '  const entry = RUANKE[name];',
  '  if (!entry) return [];',
  '  return Object.entries(entry)',
  '    .map(([year, v]) => ({ year: Number(year), score: v.score, rank: v.rank }))',
  '    .sort((a, b) => a.year - b.year);',
  '}',
  '',
];

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`已生成 ${path.relative(ROOT, OUT)}：${Object.keys(map).length} 所学校 · ${rows.length} 条记录 · 年份 ${yearList.join('/')}`);
