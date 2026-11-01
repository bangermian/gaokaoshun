/**
 * 数据解析层：把「表格内容」变成统一的记录数组。
 *
 * 支持两种填入格式：
 *
 *  A. 汇总表（推荐）—— 一个文件放任意多行，列名即语义：
 *     年份 | 招生省份 | 院校名称 | 院校所在地 | 板块 | 专业名称 |
 *     最高分 | 最低分 | 最高位次 | 最低位次 | 录取人数
 *     文件名、目录结构都不再有约束。
 *
 *  B. 旧格式（兼容）—— 一个文件 = 一所学校一年，元数据写在文件名里：
 *     `年份 招生省份 院校名称 板块 考生数.xlsx`
 *
 * 另外支持「考生数」表（与分数表放在同一工作簿或另一个文件均可）：
 *     年份 | 省份 | 考生数
 *
 * 这一层是纯函数（除了需要全局 XLSX），不碰 DOM，便于单测。
 */

import { PLATE_ALIASES, PLATES } from './config.js';
import { isBlank, toNumber } from './utils.js';

const PLATE_LOOKING = /^[a-z][a-z0-9]{0,11}$/i;

/** 表格里可能出现的中文板块名 → 规范键 */
const PLATE_TEXT_ALIASES = {
  92: '92',
  '92板块': '92',
  '九二': '92',
  双一流: 'doublefirst',
  doublefirst: 'doublefirst',
  '双一流板块': 'doublefirst',
  新型研究型: 'newresearch',
  新型研究型大学: 'newresearch',
  newresearch: 'newresearch',
  s11: 's11',
  S11: 's11',
  中外合办: 's11',
  'S11中外合办': 's11',
  双非: 'shuangfei',
  shuangfei: 'shuangfei',
  '双非板块': 'shuangfei',
};

/** 把任意板块写法归一 */
export function normalizePlate(value) {
  if (isBlank(value)) return 'shuangfei';
  const text = String(value).trim();
  const byText = PLATE_TEXT_ALIASES[text] ?? PLATE_TEXT_ALIASES[text.toLowerCase()];
  if (byText) return byText;
  const lower = text.toLowerCase();
  if (PLATE_ALIASES[lower]) return PLATE_ALIASES[lower];
  return 'shuangfei';
}

/* ------------------------------ 文件名模式（旧格式） ------------------------------ */

/**
 * 解析旧格式文件名。
 * @returns {{year:number, province:string, school:string, plate:string,
 *            candidates:number|null, warnings:string[]}|null}
 */
export function parseFileName(fileName) {
  const stem = String(fileName).replace(/\.[^.]+$/, '').trim();
  const tokens = stem.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return null;

  const warnings = [];
  const year = Number(tokens[0]);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;

  const province = tokens[1];
  if (!province) return null;

  let rest = tokens.slice(2);
  let candidates = null;

  const lastToken = rest[rest.length - 1];
  if (rest.length >= 2 && /^\d{4,6}$/.test(lastToken)) {
    candidates = Number(lastToken);
    rest = rest.slice(0, -1);
  }

  let plate = 'shuangfei';
  if (rest.length >= 2) {
    const maybePlate = rest[rest.length - 1].toLowerCase();
    if (PLATE_ALIASES[maybePlate]) {
      plate = PLATE_ALIASES[maybePlate];
      rest = rest.slice(0, -1);
    } else if (PLATE_LOOKING.test(maybePlate)) {
      warnings.push(`未知板块「${rest[rest.length - 1]}」，按双非处理`);
      rest = rest.slice(0, -1);
    }
  }

  const school = rest.join(' ').trim();
  if (!school) return null;

  return { year, province, school, plate, candidates, warnings };
}

/* ------------------------------ 表头识别 ------------------------------ */

/**
 * 识别表头。会跳过标题行、空行，在前 15 行里找最像表头的一行。
 * @returns {{map:object, headerIndex:number}|null}
 */
function locateHeader(rows, maxProbe = 15) {
  const limit = Math.min(rows.length, maxProbe);
  let best = null;

  for (let i = 0; i < limit; i += 1) {
    const cells = (rows[i] ?? []).map((cell) => String(cell ?? '').trim());
    if (cells.filter(Boolean).length < 3) continue;

    const map = {
      year: -1, province: -1, school: -1, location: -1, plate: -1, major: -1,
      highScore: -1, lowScore: -1, highRank: -1, lowRank: -1, volume: -1,
      candidates: -1, score: -1, cumulative: -1,
    };

    cells.forEach((text, index) => {
      if (!text) return;
      if (map.year === -1 && /^年份$|^年$/.test(text)) { map.year = index; return; }
      if (map.school === -1 && /院校|学校/.test(text) && !/专业/.test(text)) { map.school = index; return; }
      if (map.major === -1 && /专业/.test(text)) { map.major = index; return; }
      if (map.province === -1 && /招生省份|^省份$|生源省份/.test(text)) { map.province = index; return; }
      if (map.location === -1 && /所在地|所在省份|城市|地区/.test(text)) { map.location = index; return; }
      if (map.plate === -1 && /板块|层次|类型/.test(text)) { map.plate = index; return; }
      if (map.candidates === -1 && /考生数|考生总数|报名人数/.test(text)) { map.candidates = index; return; }
      if (map.cumulative === -1 && /累计|合计人数/.test(text)) { map.cumulative = index; return; }
      if (map.score === -1 && /^分数$|^成绩$|^投档分$/.test(text)) { map.score = index; return; }
      if (map.highScore === -1 && /最高分/.test(text)) { map.highScore = index; return; }
      if (map.lowScore === -1 && /最低分|投档线|分数线/.test(text)) { map.lowScore = index; return; }
      if (map.highRank === -1 && /最高位次|最高排名/.test(text)) { map.highRank = index; return; }
      if (map.lowRank === -1 && /最低位次|最低排名|位次/.test(text)) { map.lowRank = index; return; }
      if (map.volume === -1 && /人数|录取数|计划数/.test(text)) { map.volume = index; return; }
    });

    const isAggregate = map.year !== -1 && map.school !== -1 && map.major !== -1;
    const isCandidates = map.year !== -1 && map.candidates !== -1 && map.province !== -1 && map.school === -1;
    const isSegments = map.score !== -1 && map.cumulative !== -1;
    const isLegacy = map.major !== -1 && (map.highRank !== -1 || map.lowRank !== -1);

    if (isSegments) return { map, headerIndex: i, kind: 'segments' };
    if (isAggregate) return { map, headerIndex: i, kind: 'aggregate' };
    if (isCandidates) return { map, headerIndex: i, kind: 'candidates' };
    if (isLegacy && !best) best = { map, headerIndex: i, kind: 'legacy' };
  }

  return best;
}

/* ------------------------------ 行解析 ------------------------------ */

function readRankCells(row, map) {
  let lowRank = map.lowRank !== -1 ? toNumber(row[map.lowRank]) : null;
  let highRank = map.highRank !== -1 ? toNumber(row[map.highRank]) : null;
  if (lowRank === null && highRank === null) return null;
  if (highRank === null) highRank = lowRank;
  if (lowRank === null) lowRank = highRank;
  if (highRank > lowRank) [highRank, lowRank] = [lowRank, highRank];
  return { highRank: Math.round(highRank), lowRank: Math.round(lowRank) };
}

function readScoreCells(row, map) {
  let highScore = map.highScore !== -1 ? toNumber(row[map.highScore]) : null;
  let lowScore = map.lowScore !== -1 ? toNumber(row[map.lowScore]) : null;
  if (highScore === null && lowScore !== null) highScore = lowScore;
  if (lowScore === null && highScore !== null) lowScore = highScore;
  return { highScore, lowScore };
}

/**
 * 汇总表：一行 = 一个专业在某校某省某年的数据。
 * @returns {{records:Array<object>, warnings:string[]}|null} 非汇总表返回 null
 */
export function parseAggregateRows(rows, { fallbackLocation = '待定' } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const located = locateHeader(rows);
  if (!located || located.kind !== 'aggregate') return null;

  const { map, headerIndex } = located;
  const records = [];
  const warnings = [];
  let skipped = 0;

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    if (row.every((cell) => isBlank(cell))) continue;

    const year = toNumber(row[map.year]);
    const school = String(row[map.school] ?? '').trim();
    const major = String(row[map.major] ?? '').trim();
    if (!Number.isInteger(year) || !school || !major) { skipped += 1; continue; }

    const ranks = readRankCells(row, map);
    const scores = readScoreCells(row, map);
    // 只有分数、没有位次的推行也要保留：之后可以用「一分一段表」换算
    if (!ranks && scores.highScore === null && scores.lowScore === null) { skipped += 1; continue; }

    const province = map.province !== -1 ? String(row[map.province] ?? '').trim() : '';
    const location = map.location !== -1 ? String(row[map.location] ?? '').trim() : '';
    const volume = map.volume !== -1 ? toNumber(row[map.volume]) : null;

    records.push({
      year,
      school,
      province,
      location: location || fallbackLocation,
      plate: normalizePlate(map.plate !== -1 ? row[map.plate] : ''),
      major,
      highRank: ranks ? ranks.highRank : null,
      lowRank: ranks ? ranks.lowRank : null,
      highScore: scores.highScore,
      lowScore: scores.lowScore,
      volume: volume && volume > 0 ? Math.round(volume) : 0,
    });
  }

  if (skipped > 0) warnings.push(`跳过 ${skipped} 行（缺年份/院校/专业/位次）`);
  return { records, warnings };
}

/**
 * 考生数表：年份 | 省份 | 考生数
 * @returns {{year,province,candidates}|null} 不是考生数表返回 null
 */
export function parseCandidatesRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const located = locateHeader(rows);
  if (!located || located.kind !== 'candidates') return null;

  const { map, headerIndex } = located;
  const out = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    const year = toNumber(row[map.year]);
    const province = String(row[map.province] ?? '').trim();
    const count = toNumber(row[map.candidates]);
    if (!Number.isInteger(year) || !province || !count || count <= 0) continue;
    out.push({ year, province, candidates: Math.round(count) });
  }
  return out.length ? out : null;
}

/**
 * 一分一段表：分数 | 人数 | 累计人数
 * 用于把「只有分数、没有位次」的数据换算成位次。
 * @returns {Array<{year:number|null, province:string, score:number, cumulative:number, band:string}>|null}
 */
export function parseSegmentRows(rows) {
  if (!Array.isArray(rows) || rows.length < 3) return null;
  const located = locateHeader(rows);
  if (!located || located.kind !== 'segments') return null;

  const { map, headerIndex } = located;
  const out = [];

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    if (row.every((cell) => isBlank(cell))) continue;

    const rawScore = String(row[map.score] ?? '').trim();
    const cumulative = toNumber(row[map.cumulative]);
    if (!rawScore || !Number.isFinite(cumulative)) continue;

    // 可能是 "680-750" 这样的区间，取区间下界
    const match = rawScore.match(/(\d{2,3})/);
    if (!match) continue;
    const score = Number(match[1]);
    if (!Number.isFinite(score)) continue;

    const year = map.year !== -1 ? toNumber(row[map.year]) : null;
    const province = map.province !== -1 ? String(row[map.province] ?? '').trim() : '';

    out.push({
      year: Number.isInteger(year) ? year : null,
      province,
      score,
      cumulative: Math.round(cumulative),
      band: rawScore,
    });
  }

  return out.length ? out : null;
}

/**
 * 旧格式：只有专业维度的表格，元数据来自文件名。
 * @returns {{records:Array<object>, warnings:string[]}}
 */
export function parseSheetRows(rows) {
  const warnings = [];
  if (!Array.isArray(rows) || rows.length < 2) {
    return { records: [], warnings: ['表格为空或只有表头'] };
  }

  const located = locateHeader(rows);
  if (!located || located.map.major === -1) {
    return { records: [], warnings: ['未找到表头：需要包含「专业名称」以及「最高位次/最低位次」列'] };
  }
  if (located.map.highRank === -1 && located.map.lowRank === -1) {
    return { records: [], warnings: ['未找到位次列：需要「最高位次」或「最低位次」'] };
  }

  const { map, headerIndex } = located;
  const records = [];
  let skipped = 0;

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    if (row.every((cell) => isBlank(cell))) continue;

    const major = String(row[map.major] ?? '').trim();
    if (!major) continue;

    /*
     * 采集器导出的表里，除了专业行还夹着「院校最低线（本科批A段 普通类）」这类行。
     * 那是**学校层面的投档线**，不是一个专业 —— 当成专业会让个股下拉、热度榜、
     * 大盘聚合全部失真（实测 12k 行里有 886 行是这种）。
     * 院校线由应用自己按学校聚合，不需要这些行，直接跳过。
     */
    if (/^院校最低线/.test(major) || /^院校(最低|投档)线/.test(major)) continue;

    const ranks = readRankCells(row, map);
    if (!ranks) { skipped += 1; continue; }

    const scores = readScoreCells(row, map);
    const volume = map.volume !== -1 ? toNumber(row[map.volume]) : null;

    records.push({
      major,
      highRank: ranks.highRank,
      lowRank: ranks.lowRank,
      highScore: scores.highScore,
      lowScore: scores.lowScore,
      volume: volume && volume > 0 ? Math.round(volume) : 0,
    });
  }

  if (skipped > 0) warnings.push(`跳过 ${skipped} 行（位次为空）`);
  return { records, warnings };
}

/* ------------------------------ 文件级入口 ------------------------------ */

/**
 * 文本解码：优先 UTF-8，出现乱码时回退 GB18030（Excel 导出的中文 CSV 常见）。
 */
export function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (utf8.includes('\uFFFD')) {
    try {
      return new TextDecoder('gb18030').decode(bytes);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

/**
 * 解析单个文件（xlsx / xls / csv），自动判断是汇总表、考生数表还是旧格式。
 * @returns {{kind:'aggregate'|'legacy'|'candidates'|'unknown',
 *            records:Array<object>, candidates:Array<object>,
 *            warnings:string[], meta:object|null}}
 */
export function parseWorkbookFile({ name, relPath, buffer, XLSX }) {
  if (!XLSX) throw new Error('表格解析库 XLSX 未加载');

  const lower = String(name).toLowerCase();
  const workbook = lower.endsWith('.csv')
    ? XLSX.read(decodeText(buffer), { type: 'string' })
    : XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: false });

  const sheetNames = workbook.SheetNames ?? [];
  if (sheetNames.length === 0) {
    return { kind: 'unknown', records: [], candidates: [], warnings: [`文件没有工作表：${name}`], meta: null };
  }

  const location = deriveLocation(relPath);
  const sheets = sheetNames.map((sheetName) => ({
    name: sheetName,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1, blankrows: false, defval: null, raw: true,
    }),
  }));

  // 1) 考生数表（可能与分数表在同一个工作簿的不同 sheet）
  const candidates = [];
  for (const sheet of sheets) {
    const parsed = parseCandidatesRows(sheet.rows);
    if (parsed) candidates.push(...parsed);
  }

  const warnings = [];

  // 2) 一分一段表
  const segments = [];
  for (const sheet of sheets) {
    const parsed = parseSegmentRows(sheet.rows);
    if (parsed) segments.push(...parsed);
  }
  if (segments.length > 0) {
    return { kind: 'segments', records: [], candidates, segments, warnings, meta: null };
  }

  // 3) 汇总表
  const aggregateRecords = [];
  let hasAggregate = false;
  for (const sheet of sheets) {
    const parsed = parseAggregateRows(sheet.rows, { fallbackLocation: location });
    if (parsed) {
      hasAggregate = true;
      aggregateRecords.push(...parsed.records);
      warnings.push(...parsed.warnings);
    }
  }
  if (hasAggregate) {
    return { kind: 'aggregate', records: aggregateRecords, candidates, warnings, meta: null };
  }
  if (candidates.length > 0) {
    return { kind: 'candidates', records: [], candidates, warnings, meta: null };
  }

  // 3) 旧格式：元数据从文件名来
  const meta = parseFileName(name);
  if (!meta) {
    return {
      kind: 'unknown',
      records: [],
      candidates: [],
      warnings: [`无法识别：既不是汇总表，文件名也不符合「年份 招生省份 院校 板块 考生数」`],
      meta: null,
    };
  }

  let result = { records: [], warnings: [] };
  for (const sheet of sheets) {
    const parsed = parseSheetRows(sheet.rows);
    if (parsed.records.length > 0) { result = parsed; break; }
    result = parsed;
  }

  const records = result.records.map((record) => ({
    ...record,
    year: meta.year,
    school: meta.school,
    province: meta.province,
    location,
    plate: meta.plate,
  }));

  return {
    kind: 'legacy',
    records,
    candidates: meta.candidates ? [{ year: meta.year, province: meta.province, candidates: meta.candidates }] : [],
    warnings: [...meta.warnings, ...result.warnings],
    meta: { ...meta, location },
  };
}

/**
 * 从相对路径推断「学校所在地」= 数据根目录下的一级文件夹。
 */
export function deriveLocation(relPath) {
  const normalized = String(relPath ?? '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  const folder = parts[0].trim();
  return folder && folder !== '未知' ? folder : '';
}

/** 板块是否合法 */
export function isKnownPlate(plate) {
  return PLATES.includes(plate);
}
