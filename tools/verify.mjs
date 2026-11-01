/**
 * 回归测试（零依赖）：node tools/verify.mjs
 *
 * 覆盖：文件名解析、汇总表解析、考生数表、加权聚合、百分位、指数算法、状态增删改。
 */

import assert from 'node:assert/strict';
import {
  aggregateMajors, csvCell, csvRow, parseArgs, parseCsv,
} from './crawl.mjs';
import { buildRankDistribution, heatOfRank, majorHeat, percentileOf, rankMajorsByHeat } from '../assets/js/heat.js';
import {
  attachPercentiles, detectOutliers, movingAverage, quantile, toCandles, yearlyAggregate,
} from '../assets/js/aggregate.js';
import { computeIndices } from '../assets/js/indices.js';
import { platesOf, regionOfProvince, provincesOfRegion } from '../assets/js/config.js';
import {
  normalizePlate, parseAggregateRows, parseCandidatesRows, parseFileName, parseSegmentRows, parseSheetRows,
} from '../assets/js/parser.js';
import {
  addMajorRecord, applyCandidateRecords, applyParsedFile, applyPlanRecords, applyRecords,
  applySegmentRecords, countMissingCandidates, countRecords, createState, deserialize,
  candidatesSource, rankForScore, removeYear, serialize,
} from '../assets/js/state.js';
import { parsePastedTable, sumPlan } from '../assets/js/paste.js';

let passed = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

/* ------------------------------ 文件名（旧格式） ------------------------------ */

test('旧格式文件名：年份/省份/院校/板块/考生数', () => {
  const meta = parseFileName('2025 天津 天津工业大学 doublefirst 74000.xlsx');
  assert.equal(meta.year, 2025);
  assert.equal(meta.province, '天津');
  assert.equal(meta.school, '天津工业大学');
  assert.equal(meta.plate, 'doublefirst');
  assert.equal(meta.candidates, 74000);
});

test('旧格式：省略板块与考生数时板块回落双非', () => {
  const meta = parseFileName('2025 天津 天津工业大学.xlsx');
  assert.equal(meta.plate, 'shuangfei');
  assert.equal(meta.candidates, null);
});

test('旧格式：院校名带空格不会被拆碎', () => {
  const meta = parseFileName('2025 天津 中国人民大学 苏州校区 doublefirst 74000.xlsx');
  assert.equal(meta.school, '中国人民大学 苏州校区');
});

test('非法文件名返回 null', () => {
  assert.equal(parseFileName('随便一个文件.xlsx'), null);
});

/* ------------------------------ 汇总表（新格式） ------------------------------ */

const AGGREGATE_HEADER = ['年份', '招生省份', '院校名称', '院校所在地', '板块', '专业名称',
  '最高分', '最低分', '最高位次', '最低位次', '录取人数'];

test('汇总表：一行一条，自动识别列', () => {
  const rows = [
    ['2025 年录取数据'],
    AGGREGATE_HEADER,
    [2025, '天津', '天津工业大学', '天津', '双一流', '计算机', 630, 610, 7000, 11000, 10],
    [2024, '天津', '天津工业大学', '天津', '双一流', '计算机', 620, 600, 8000, 12000, 10],
  ];
  const { records } = parseAggregateRows(rows);
  assert.equal(records.length, 2);
  assert.equal(records[0].school, '天津工业大学');
  assert.equal(records[0].province, '天津');
  assert.equal(records[0].location, '天津');
  assert.equal(records[0].plate, 'doublefirst');
  assert.equal(records[0].year, 2025);
  assert.equal(records[1].year, 2024);
});

test('汇总表：中文板块名归一', () => {
  assert.equal(normalizePlate('双一流'), 'doublefirst');
  assert.equal(normalizePlate('双非'), 'shuangfei');
  assert.equal(normalizePlate('S11'), 's11');
  assert.equal(normalizePlate('92'), '92');
  assert.equal(normalizePlate(''), 'shuangfei');
});

test('汇总表：只有分数没有位次的行会保留，等待一分一段表换算', () => {
  const rows = [
    AGGREGATE_HEADER,
    [2025, '天津', 'A大学', '天津', '双一流', '计算机', 600, 590, null, null, 5],
    [2025, '天津', 'A大学', '天津', '双一流', '数学', 600, 590, 1000, 2000, 5],
    [2025, '天津', 'A大学', '天津', '双一流', '空行', null, null, null, null, 5],
  ];
  const { records } = parseAggregateRows(rows);
  assert.equal(records.length, 2);
  assert.equal(records[0].lowRank, null);
  assert.equal(records[0].lowScore, 590);
});

test('汇总表：院校所在地缺省时回落到文件夹名', () => {
  const rows = [
    ['年份', '招生省份', '院校名称', '专业名称', '最低位次'],
    [2025, '天津', 'A大学', '计算机', 12000],
  ];
  const { records } = parseAggregateRows(rows, { fallbackLocation: '河北' });
  assert.equal(records[0].location, '河北');
});

test('考生数表可独立识别', () => {
  const rows = [['年份', '省份', '考生数'], [2025, '天津', 74000], [2024, '天津', 70800]];
  const list = parseCandidatesRows(rows);
  assert.equal(list.length, 2);
  assert.equal(list[0].candidates, 74000);
});

test('普通表格不会被误判成考生数表', () => {
  const rows = [['年份', '院校名称', '专业名称', '最低位次'], [2025, 'A', '计算机', 1000]];
  assert.equal(parseCandidatesRows(rows), null);
});

/* ------------------------------ 旧格式表格 ------------------------------ */

test('旧格式表格：表头不在第一行也能定位', () => {
  const rows = [
    ['2025 年统计'],
    [],
    ['专业名称', '最高分', '最低分', '最高位次', '最低位次', '录取人数'],
    ['计算机', 600, 590, 9000, 12000, 10],
  ];
  const { records } = parseSheetRows(rows);
  assert.equal(records.length, 1);
  assert.equal(records[0].lowRank, 12000);
});

test('旧格式表格：位次填反自动交换', () => {
  const rows = [['专业名称', '最高位次', '最低位次'], ['数学', 20000, 10000]];
  const { records } = parseSheetRows(rows);
  assert.equal(records[0].highRank, 10000);
  assert.equal(records[0].lowRank, 20000);
});

/* ------------------------------ 聚合与百分位 ------------------------------ */

const majors = {
  计算机: [
    { year: 2024, highScore: 620, lowScore: 600, highRank: 8000, lowRank: 12000, volume: 10 },
    { year: 2025, highScore: 630, lowScore: 610, highRank: 7000, lowRank: 11000, volume: 10 },
  ],
  材料: [
    { year: 2024, highScore: 610, lowScore: 590, highRank: 15000, lowRank: 20000, volume: 30 },
    { year: 2025, highScore: 615, lowScore: 595, highRank: 14000, lowRank: 19000, volume: 30 },
  ],
};

test('收盘位次 = 各专业录取线按招生人数加权', () => {
  const series = yearlyAggregate(majors);
  // 2024: (12000×10 + 20000×30) / 40 = 18000
  // 2025: (11000×10 + 19000×30) / 40 = 17000
  assert.equal(series[0].close, 18000);
  assert.equal(series[1].close, 17000);
});

test('影线与招生数', () => {
  const [y2024] = yearlyAggregate(majors);
  // 影线 = 各专业录取线的跨度：计算机 12000 ~ 材料 20000
  assert.equal(y2024.best, 12000);
  assert.equal(y2024.worst, 20000);
  assert.equal(y2024.volume, 40);
});

test('百分位 = 位次 / 考生数，缺考生数时标记估算', () => {
  const years = yearlyAggregate(majors);
  const withCand = attachPercentiles(years, { 2024: 70000, 2025: 74000 });
  assert.equal(withCand[0].percentile, 25.71); // 18000/70000*100
  assert.equal(withCand[0].percentileEstimated, false);
  // 2025 有考生数
  assert.equal(withCand[1].percentileEstimated, false);

  const noCand = attachPercentiles(years, { 2024: 70000 });
  assert.equal(noCand[1].percentileEstimated, true); // 2025 缺失 → 估算
});

test('开盘 = 上一年收盘，low ≤ high', () => {
  const candles = toCandles(yearlyAggregate(majors));
  assert.equal(candles[0].open, candles[0].close);
  assert.equal(candles[1].open, candles[0].close);
  for (const candle of candles) {
    assert.ok(candle.low <= candle.high);
  }
});

test('均线：前 n-1 个点为占位符', () => {
  const series = [{ close: 10 }, { close: 20 }, { close: 30 }];
  assert.deepEqual(movingAverage(series, 2), ['-', 15, 25]);
});

/* ------------------------------ 指数算法 ------------------------------ */

function fixtureState() {
  const state = createState();
  state.schools = {
    A: { name: 'A', school: 'A', province: '天津', plate: 'doublefirst', location: '天津', majors: {},
      series: [{ year: 2024, close: 10000, volume: 10, percentile: 14.29 }] },
    B: { name: 'B', school: 'B', province: '天津', plate: 's11', location: '浙江', majors: {},
      series: [{ year: 2024, close: 20000, volume: 30, percentile: 28.57 }] },
    C: { name: 'C', school: 'C', province: '浙江', plate: 's11', location: '浙江', majors: {},
      series: [{ year: 2024, close: 30000, volume: 10, percentile: 60 }] },
  };
  return state;
}

test('地点板块 = 100 - 加权平均百分位', () => {
  const { plate } = computeIndices(fixtureState());
  assert.equal(plate.loc_天津_all.data[0].close, 85.71);
  // 浙江 = (28.57*30 + 60*10) / 40 = 36.4275 → 36.43 → 热度 63.57
  assert.equal(plate.loc_浙江_all.data[0].close, 63.57);
});

test('大盘按所在地聚合，跨省百分位可直接平均', () => {
  const { market } = computeIndices(fixtureState());
  const east = market.east.data[0];
  // (14.29*10 + 28.57*30 + 60*10) / 50 = 32 → 热度 68
  assert.equal(east.percentile, 32);
  assert.equal(east.close, 68);
  assert.equal(east.schools, 3);
});

test('板块筛选只统计对应板块', () => {
  const { plate } = computeIndices(fixtureState());
  assert.equal(plate.east_s11.data[0].close, 63.57);
  assert.equal(plate.east_doublefirst.data[0].close, 85.71);
  assert.equal(plate.east_92.data.length, 0);
});

test('没有百分位的院校不进入指数', () => {
  const state = fixtureState();
  state.schools.A.series = [{ year: 2024, close: 10000, volume: 10, percentile: null }];
  const { market } = computeIndices(state);
  assert.equal(market.east.data[0].schools, 2);
});

test('基准线：同省同板块的平均百分位', () => {
  const { benchmarks } = computeIndices(fixtureState());
  assert.equal(benchmarks['天津|doublefirst'][0].percentile, 14.29);
  assert.equal(benchmarks['天津|s11'][0].percentile, 28.57);
  assert.equal(benchmarks['浙江|s11'][0].percentile, 60);
});

test('省份 → 区域：联动下拉靠它', () => {
  assert.equal(regionOfProvince('天津'), 'east');
  assert.equal(regionOfProvince('山东'), 'jiaodong');
  assert.equal(regionOfProvince('黑龙江'), 'northeast');
  assert.equal(regionOfProvince(' 浙江 '), 'east');
  assert.equal(regionOfProvince('待定'), null);
  assert.equal(regionOfProvince(''), null);
  assert.deepEqual(provincesOfRegion('jiaodong'), ['山东']);
  assert.deepEqual(provincesOfRegion('unknown'), []);
});

test('板块是标签：985/211 同时属于 92 和双一流', () => {
  const state = createState();
  state.schools = {
    X: {
      name: 'X', school: 'X', province: '天津', plate: '92', location: '天津', majors: {},
      series: [{ year: 2024, close: 10000, volume: 10, percentile: 20 }],
    },
  };
  const { plate } = computeIndices(state);
  // 92 桶里有
  assert.equal(plate.east_92.data[0].schools, 1);
  // 双一流桶里也应该有（旧版这里是 0，正是"选双一流刷不出来"的原因）
  assert.equal(plate.east_doublefirst.data[0].schools, 1);
  // 双非桶里没有
  assert.equal(plate.east_shuangfei.data.length, 0);
});

/* ------------------------------ 状态 ------------------------------ */

function record(overrides = {}) {
  return {
    year: 2025, school: 'S', province: '天津', location: '天津', plate: 's11',
    major: 'A', highRank: 100, lowRank: 200, highScore: 600, lowScore: 590, volume: 10,
    ...overrides,
  };
}

test('重复导入是幂等的', () => {
  const state = createState();
  applyRecords(state, [record()]);
  applyRecords(state, [record()]);
  assert.equal(countRecords(state), 1);
});

test('同一年不同专业分别计入并加权', () => {
  const state = createState();
  applyRecords(state, [record({ major: 'A', highRank: 100, lowRank: 200, volume: 10 })]);
  applyRecords(state, [record({ major: 'B', highRank: 300, lowRank: 400, volume: 10 })]);
  assert.equal(countRecords(state), 2);
  const series = state.schools['S_天津'].series;
  assert.equal(series.length, 1);
  assert.equal(series[0].close, 300); // (200×10 + 400×10) / 20
});

test('考生数写入后百分位随之更新', () => {
  const state = createState();
  applyRecords(state, [record({ highRank: 100, lowRank: 200, volume: 10 })]);
  assert.equal(state.schools['S_天津'].series[0].percentileEstimated, true);
  applyCandidateRecords(state, [{ year: 2025, province: '天津', candidates: 100000 }]);
  const candle = state.schools['S_天津'].series[0];
  assert.equal(candle.percentileEstimated, false);
  assert.equal(candle.percentile, 0.2); // 200/100000*100
});

test('没有考生数时，用一分一段表的末行累计人数反推', () => {
  const state = createState();
  applyRecords(state, [record({ highRank: 100, lowRank: 200, volume: 10 })]);
  // 一分一段：累计人数最大值就是该年考生规模
  applySegmentRecords(state, [
    { province: '天津', year: 2025, score: 690, cumulative: 300 },
    { province: '天津', year: 2025, score: 680, cumulative: 1200 },
    { province: '天津', year: 2025, score: 670, cumulative: 52000 },
  ]);
  const candle = state.schools['S_天津'].series[0];
  assert.equal(candle.candidates, 52000);
  assert.equal(candle.percentile, 0.38); // 200/52000*100 ≈ 0.3846 → 0.38
  assert.equal(candidatesSource(state, '天津', 2025), 'segment');
});

test('显式填的考生数优先于一分一段推导', () => {
  const state = createState();
  applyRecords(state, [record({ highRank: 100, lowRank: 200, volume: 10 })]);
  applySegmentRecords(state, [{ province: '天津', year: 2025, score: 670, cumulative: 52000 }]);
  applyCandidateRecords(state, [{ year: 2025, province: '天津', candidates: 74000 }]);
  const candle = state.schools['S_天津'].series[0];
  assert.equal(candle.candidates, 74000);
  assert.equal(candidatesSource(state, '天津', 2025), 'declared');
});

test('两者都没有时才算缺失', () => {
  const state = createState();
  applyRecords(state, [record({ highRank: 100, lowRank: 200, volume: 10 })]);
  assert.equal(candidatesSource(state, '天津', 2025), 'missing');
  assert.equal(countMissingCandidates(state), 1);
});

test('applyParsedFile 同时接受记录与考生数', () => {
  const state = createState();
  applyParsedFile(state, {
    kind: 'aggregate',
    records: [record(), record({ year: 2024 })],
    candidates: [{ year: 2025, province: '天津', candidates: 74000 }],
  });
  assert.equal(countRecords(state), 2);
  assert.equal(state.provinceCandidates['天津'][2025], 74000);
});

test('缺失考生数的年份会被统计出来', () => {
  const state = createState();
  applyRecords(state, [record(), record({ year: 2024 })]);
  assert.equal(countMissingCandidates(state), 2);
  applyCandidateRecords(state, [{ year: 2025, province: '天津', candidates: 74000 }]);
  assert.equal(countMissingCandidates(state), 1);
});

test('手动录入覆盖同年记录', () => {
  const state = createState();
  applyRecords(state, [record()]);
  const result = addMajorRecord(state, {
    school: 'S', province: '天津', major: 'A', year: 2025, highRank: 50, lowRank: 60, volume: 2,
  });
  assert.ok(result.ok);
  assert.equal(countRecords(state), 1);
  assert.equal(state.schools['S_天津'].series[0].close, 60);
});

test('删除某年后派生数据同步更新', () => {
  const state = createState();
  applyRecords(state, [record({ year: 2024 }), record({ year: 2025 })]);
  assert.equal(state.schools['S_天津'].series.length, 2);
  removeYear(state, 'S_天津', 2024);
  assert.equal(state.schools['S_天津'].series.length, 1);
});

test('缓存序列化后可完整还原（含考生数）', () => {
  const state = createState();
  applyRecords(state, [record()]);
  applyCandidateRecords(state, [{ year: 2025, province: '天津', candidates: 100000 }]);
  const restored = deserialize(serialize(state));
  assert.ok(restored);
  assert.equal(countRecords(restored), 1);
  assert.equal(restored.provinceCandidates['天津'][2025], 100000);
  assert.equal(restored.schools['S_天津'].series[0].percentile, 0.2);
});

test('版本不一致的缓存会被丢弃', () => {
  assert.equal(deserialize('{"schemaVersion":1,"schools":{}}'), null);
  assert.equal(deserialize('not json'), null);
});

/* ------------------------------ 一分一段表 ------------------------------ */

test('一分一段表可识别（分数 + 累计人数）', () => {
  const rows = [
    ['分数', '人数', '累计人数'],
    ['680-750', 656, 656],
    ['679', 66, 722],
    ['678', 67, 789],
  ];
  const list = parseSegmentRows(rows);
  assert.equal(list.length, 3);
  assert.equal(list[0].score, 680);      // 区间取了下界
  assert.equal(list[0].cumulative, 656);
  assert.equal(list[2].score, 678);
});

test('普通分数表不会被误判成一分一段表', () => {
  const rows = [
    ['年份', '院校名称', '专业名称', '最低分', '最低位次'],
    [2025, 'A大学', '计算机', 600, 1000],
  ];
  assert.equal(parseSegmentRows(rows), null);
});

test('分数 → 位次：落在哪一档取哪一档的累计人数', () => {
  const state = createState();
  applySegmentRecords(state, [
    { province: '天津', year: 2025, score: 690, cumulative: 100 },
    { province: '天津', year: 2025, score: 680, cumulative: 300 },
    { province: '天津', year: 2025, score: 670, cumulative: 600 },
  ]);
  assert.equal(rankForScore(state, '天津', 2025, 690), 100);
  assert.equal(rankForScore(state, '天津', 2025, 685), 300);   // 690~680 之间 → 680 档
  assert.equal(rankForScore(state, '天津', 2025, 670), 600);
  assert.equal(rankForScore(state, '天津', 2025, 650), null);  // 低于表尾，查不到就是不猜
  assert.equal(rankForScore(state, '天津', 2024, 680), null);  // 没有该年
});

test('只有分数时导入会自动补上位次', () => {
  const state = createState();
  applySegmentRecords(state, [
    { province: '天津', year: 2025, score: 680, cumulative: 300 },
    { province: '天津', year: 2025, score: 679, cumulative: 350 },
  ]);
  const result = applyRecords(state, [{
    year: 2025, school: 'S', province: '天津', location: '天津', plate: 's11',
    major: 'A', highScore: null, lowScore: 679, highRank: null, lowRank: null, volume: 0,
  }]);
  assert.equal(result.added, 1);
  assert.equal(result.converted, 1);
  // 679 是表里真实存在的档位，直接用累计人数，不做估算
  assert.equal(state.schools['S_天津'].series[0].close, 350);
});

test('高分段（表里最高档以上）用指数衰减估算位次', () => {
  const state = createState();
  applySegmentRecords(state, [
    { province: '天津', year: 2025, score: 680, cumulative: 300 },
    { province: '天津', year: 2025, score: 679, cumulative: 350 },
  ]);
  // λ = ln(300/350) ≈ -0.1542；685 分 → 300·e^(-0.771) ≈ 139
  assert.equal(rankForScore(state, '天津', 2025, 685), 139);
  // 表里有的档位仍是真实值
  assert.equal(rankForScore(state, '天津', 2025, 680), 300);
  // 外推到离谱的分数，至少第 1 名，不会出现 0 或负数
  const extreme = rankForScore(state, '天津', 2025, 780);
  assert.ok(extreme >= 1, `应 ≥ 1，实际 ${extreme}`);
  // 分数越高，估算位次越小
  assert.ok(rankForScore(state, '天津', 2025, 690) < rankForScore(state, '天津', 2025, 685));
});

test('既无位次也换算不了的行会被跳过并计数', () => {
  const state = createState();
  const result = applyRecords(state, [{
    year: 2025, school: 'S', province: '天津', location: '天津', plate: 's11',
    major: 'A', highScore: null, lowScore: 675, highRank: null, lowRank: null, volume: 0,
  }]);
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1);
});

test('缓存里保留一分一段表', () => {
  const state = createState();
  applySegmentRecords(state, [{ province: '天津', year: 2025, score: 680, cumulative: 300 }]);
  const restored = deserialize(serialize(state));
  assert.equal(rankForScore(restored, '天津', 2025, 680), 300);
});

/* ------------------------------ 粘贴导入 ------------------------------ */

const PLAN_PASTE = `专业名称\t计划招生\t学制/学费
工科试验班\t81\t四年/5800元
工科试验班\t69\t四年/5800元
建筑类\t30\t五年/5000元`;

test('粘贴：认出招生计划并按专业合计', () => {
  const { kind, rows } = parsePastedTable(PLAN_PASTE);
  assert.equal(kind, 'plan');
  assert.equal(rows.length, 3);
  assert.equal(sumPlan(rows), 180);
});

test('粘贴：认出一分一段表', () => {
  const text = '分数\t人数\t累计人数\n680-750\t656\t656\n679\t66\t722';
  const { kind, rows } = parsePastedTable(text);
  assert.equal(kind, 'segment');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].score, 680);
  assert.equal(rows[1].cumulative, 722);
});

test('粘贴：认出分数数据（含 分数/位次 合并列）', () => {
  const text = '专业名称\t最低分/最低位次\n计算机\t670/1301\n法学\t664/1828';
  const { kind, rows } = parsePastedTable(text);
  assert.equal(kind, 'score');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].lowScore, 670);
  assert.equal(rows[0].lowRank, 1301);
});

test('粘贴：认不出表头时明确报错而不是瞎猜', () => {
  const { kind, warnings } = parsePastedTable('随便写点\t没用的\n内容\t在这');
  assert.equal(kind, 'unknown');
  assert.ok(warnings.length > 0);
});

test('招生计划写入后覆盖成交量', () => {
  const state = createState();
  applyRecords(state, [{
    year: 2025, school: 'S', province: '天津', location: '天津', plate: 's11',
    major: '院校最低线', highRank: 100, lowRank: 200, volume: 0,
  }]);
  assert.equal(state.schools['S_天津'].series[0].volume, 0);
  const result = applyPlanRecords(state, [{ school: 'S', province: '天津', year: 2025, plan: 180 }]);
  assert.equal(result.written, 1);
  assert.equal(state.schools['S_天津'].series[0].volume, 180);
});

/* ------------------------------ 稳健分差 / 录取率 / 断档 ------------------------------ */

test('分位数用线性插值（与 Excel PERCENTILE.INC 同口径）', () => {
  const sorted = [590, 600, 610, 620, 700];
  assert.equal(quantile(sorted, 0.1), 594);   // 590 + 0.4×10
  assert.equal(quantile(sorted, 0.9), 668);   // 620 + 0.6×80
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([600], 0.9), 600);
});

test('分差用 P10–P90，比 max−min 抗极值', () => {
  const majors = {
    A: [{ year: 2025, highRank: 1000, lowRank: 2000, lowScore: 700, highScore: 700, volume: 5 }],
    B: [{ year: 2025, highRank: 2000, lowRank: 3000, lowScore: 620, highScore: 620, volume: 5 }],
    C: [{ year: 2025, highRank: 3000, lowRank: 4000, lowScore: 610, highScore: 610, volume: 5 }],
    D: [{ year: 2025, highRank: 4000, lowRank: 5000, lowScore: 600, highScore: 600, volume: 5 }],
    E: [{ year: 2025, highRank: 5000, lowRank: 6000, lowScore: 590, highScore: 590, volume: 5 }],
  };
  const [y] = yearlyAggregate(majors);
  assert.equal(y.spread, 74);          // P90 668 − P10 594
  assert.ok(y.spread < 700 - 590);     // 明显小于极差 110
});

test('录取率估计 = 招生人数 / 位次', () => {
  const majors = { A: [{ year: 2025, highRank: 10000, lowRank: 10000, lowScore: 600, highScore: 600, volume: 50 }] };
  const [y] = yearlyAggregate(majors);
  assert.equal(y.difficulty, 0.5); // 50 / 10000 * 100
});

test('断档检测：同比跳变被标记，平稳序列不标记', () => {
  const jumpy = [
    { year: 2020, close: 10000 }, { year: 2021, close: 9000 },
    { year: 2022, close: 8000 }, { year: 2023, close: 30000 },
    { year: 2024, close: 12000 },
  ];
  const { flagged } = detectOutliers(jumpy);
  assert.ok(flagged.has(2023), '2023 应被标为异常');

  const smooth = [
    { year: 2020, close: 10000 }, { year: 2021, close: 9800 },
    { year: 2022, close: 9600 }, { year: 2023, close: 9500 }, { year: 2024, close: 9400 },
  ];
  assert.equal(detectOutliers(smooth).flagged.size, 0);
});

test('样本过少的年份会被打标', () => {
  const majors = { A: [{ year: 2025, highRank: 1000, lowRank: 2000, lowScore: 600, highScore: 600, volume: 5 }] };
  const candles = toCandles(yearlyAggregate(majors));
  assert.equal(candles[0].lowSample, true);
});

/* ------------------------------ 直连抓取（crawl.mjs） ------------------------------ */

test('抓取：专业按大类聚合，人数相加、最低分取最低、位次取最大', () => {
  const agg = aggregateMajors([
    { sp_name: '机器人工程', min: '705', min_section: '900', lq_num: '2' },
    { sp_name: '机器人工程 （荣誉项目班）', min: '700', min_section: '1200', lq_num: '3' },
    { sp_name: '机器人工程 （荣誉项目班；校本部）', min: '702', min_section: '1100', lq_num: '-' },
  ]);
  assert.equal(agg.length, 1);
  const g = agg[0];
  assert.equal(g.major, '机器人工程');
  assert.equal(g.minScore, 700);   // 最低分取最低 = 最好考的那条线
  assert.equal(g.minRank, 1200);   // 最低位次取最大 = 最差的名次
  assert.equal(g.volume, 5);       // 2 + 3，"-" 不计入
  assert.equal(g.variants, 3);
});

test('抓取：全部人数都是 "-" 时留空而不是 0', () => {
  const agg = aggregateMajors([{ sp_name: '工科试验班', min: '690', min_section: '800', lq_num: '-' }]);
  assert.equal(agg[0].volume, null);
});

test('抓取：CSV 转义（逗号/引号/换行）', () => {
  assert.equal(csvCell('清华'), '清华');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('说"好"'), '"说""好"""');
  assert.equal(csvRow(['2024', '天津', 'a,b']), '2024,天津,"a,b"');
});

test('抓取：CSV 解析能吃回带引号的字段', () => {
  const rows = parseCsv('年份,专业名称\r\n2024,"计算机, 软件"\r\n2023,"说""好"""');
  assert.deepEqual(rows[0], ['年份', '专业名称']);
  assert.deepEqual(rows[1], ['2024', '计算机, 软件']);
  assert.deepEqual(rows[2], ['2023', '说"好"']);
});

test('抓取：命令行参数解析与钳制', () => {
  const a = parseArgs(['--province', '天津', '--from', '1', '--to', '200', '--years', '2025,2024', '-c', '9']);
  assert.equal(a.province, '天津');
  assert.equal(a.from, 1);
  assert.equal(a.to, 200);
  assert.deepEqual(a.years, [2025, 2024]);
  assert.equal(a.concurrency, 8);           // 上限 8

  const b = parseArgs(['--from', '10', '--to', '3']);
  assert.equal(b.to, 10);                   // to < from 时纠正
  assert.equal(b.concurrency, 4);           // 默认值
});

/* ------------------------------ 专业热度 ------------------------------ */

function heatState() {
  const state = createState();
  applyRecords(state, [
    { year: 2025, school: 'A', province: '天津', location: '天津', plate: 's11', major: '计算机', highRank: null, lowRank: 100, lowScore: 700, highScore: 700, volume: 10 },
    { year: 2025, school: 'A', province: '天津', location: '天津', plate: 's11', major: '化学', highRank: null, lowRank: 900, lowScore: 650, highScore: 650, volume: 10 },
    { year: 2025, school: 'B', province: '天津', location: '天津', plate: 's11', major: '数学', highRank: null, lowRank: 500, lowScore: 680, highScore: 680, volume: 10 },
  ]);
  return state;
}

test('热度：位次分位按全省同年的专业分布算', () => {
  const state = heatState();
  const ranks = buildRankDistribution(state, '天津', 2025);
  assert.deepEqual(ranks, [100, 500, 900]);
  // 100 前面没有更小的 → 分位 0 → 热度 100
  assert.equal(percentileOf(ranks, 100), 0);
  assert.equal(heatOfRank(ranks, 100), 100);
  assert.equal(heatOfRank(ranks, 500), 66.67);
  assert.equal(heatOfRank(ranks, 900), 33.33);
});

test('热度：样本不足时返回 null，不瞎猜', () => {
  const state = createState();
  applyRecords(state, [{ year: 2025, school: 'A', province: '天津', location: '天津', plate: 's11', major: '计算机', highRank: null, lowRank: 100, lowScore: 700, highScore: 700, volume: 10 }]);
  assert.equal(heatOfRank(buildRankDistribution(state, '天津', 2025), 100), null);
});

test('热度：校内溢价为正说明该专业比本校平均更难进', () => {
  const state = heatState();
  const hot = majorHeat(state, { school: 'A', province: '天津', year: 2025, major: '计算机' });
  const cold = majorHeat(state, { school: 'A', province: '天津', year: 2025, major: '化学' });
  assert.ok(hot.relHeat > 0, '计算机应比校内平均更热');
  assert.ok(cold.relHeat < 0, '化学应比校内平均更冷');
  assert.equal(hot.heat, 100);
  assert.equal(cold.heat, 33.33);
});

test('热度：榜单按热度从高到低排', () => {
  const state = heatState();
  const list = rankMajorsByHeat(state, '天津', 2025, 10);
  assert.equal(list.length, 3);
  assert.equal(list[0].major, '计算机');
  assert.equal(list[2].major, '化学');
});

/* ------------------------------ 执行 ------------------------------ */

let failed = 0;
for (const { name, fn } of cases) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${cases.length} total`);
process.exit(failed === 0 ? 0 : 1);
