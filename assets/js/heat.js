/**
 * 专业热度
 *
 * 思路：把「录取位次」放到**全省所有专业**的位次分布里看，比的是"这个专业在全省所有招生专业里有多难进"。
 * 位次越靠前 → 热度越高。这样跨学校、跨专业之间才有可比性。
 *
 *   分位 P = 该专业位次在全省专业位次分布中的位置（0 = 最难，100 = 最易）
 *   热度 H = 100 - P                    → 0–100，越高越热
 *
 * 再给两个衍生指标：
 *   校内溢价 = 该专业热度 - 该校当年所有专业的加权平均热度
 *             （正数 = 这个专业比该校平均水平更热门）
 *   热度趋势 = 最近一年热度 - 最早一年热度（只取最近 3 年）
 *
 * 口径说明：
 *   · 只用同一个省、同一年内的数据做分布，跨省不可比（各省考生规模差太多）
 *   · 位次缺失的专业不参与
 *   · 学校整体（未选专业）的热度沿用原来的考生数百分位口径，两者不同，不要混用
 */

/** 取某省某年所有专业的位次（升序），用作分布底表 */
export function buildRankDistribution(state, province, year) {
  const ranks = [];
  for (const item of Object.values(state.schools ?? {})) {
    if (item.province !== province) continue;
    for (const records of Object.values(item.majors ?? {})) {
      for (const r of records) {
        if (Number(r.year) !== Number(year)) continue;
        if (Number.isFinite(r.lowRank) && r.lowRank > 0) ranks.push(r.lowRank);
      }
    }
  }
  return ranks.sort((a, b) => a - b);
}

/** 二分查找：value 在升序数组中的插入位置 */
function lowerBound(arr, value) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 某个位次在分布里的分位（0–100）。
 * 用"严格小于它的个数 / 总数"，位次 1 得到 0，最末位得到接近 100。
 */
export function percentileOf(ranks, rank) {
  if (!Array.isArray(ranks) || ranks.length < 2) return null;
  if (!Number.isFinite(rank) || rank <= 0) return null;
  const idx = lowerBound(ranks, rank);
  return round2((idx / ranks.length) * 100);
}

const round2 = (v) => Math.round(v * 100) / 100;

/** 位次 → 热度分（0–100） */
export function heatOfRank(ranks, rank) {
  const p = percentileOf(ranks, rank);
  if (p == null) return null;
  return round2(100 - p);
}

/**
 * 综合热度：给某个专业算一份完整的热度画像。
 * 返回 { heat, percentile, relHeat, trend, samples }
 */
export function majorHeat(state, { school, province, year, major }) {
  const item = state.schools?.[`${school}_${province}`];
  if (!item) return null;
  const records = item.majors?.[major] ?? [];
  const target = records.find((r) => Number(r.year) === Number(year));
  if (!target || !Number.isFinite(target.lowRank)) return null;

  const ranks = buildRankDistribution(state, province, year);
  const heat = heatOfRank(ranks, target.lowRank);
  if (heat == null) return { heat: null, percentile: null, relHeat: null, trend: null, samples: ranks.length };

  // 校内溢价：拿该校当年"按录取人数加权的平均位次"折算成热度，再相减
  let weightedRank = 0;
  let weightSum = 0;
  for (const recs of Object.values(item.majors ?? {})) {
    for (const r of recs) {
      if (Number(r.year) !== Number(year)) continue;
      if (!Number.isFinite(r.lowRank)) continue;
      const w = Number.isFinite(r.volume) && r.volume > 0 ? r.volume : 1;
      weightedRank += r.lowRank * w;
      weightSum += w;
    }
  }
  let relHeat = null;
  if (weightSum > 0) {
    const schoolHeat = heatOfRank(ranks, weightedRank / weightSum);
    if (schoolHeat != null) relHeat = round2(heat - schoolHeat);
  }

  // 趋势：最近 3 年内，最早一年与最新一年的热度差
  const years = [...new Set(records.map((r) => Number(r.year)))].sort((a, b) => a - b).slice(-3);
  let trend = null;
  if (years.length >= 2) {
    const first = records.find((r) => Number(r.year) === years[0]);
    const last = records.find((r) => Number(r.year) === years[years.length - 1]);
    const h1 = first && heatOfRank(buildRankDistribution(state, province, years[0]), first.lowRank);
    const h2 = last && heatOfRank(buildRankDistribution(state, province, years[years.length - 1]), last.lowRank);
    if (h1 != null && h2 != null) trend = round2(h2 - h1);
  }

  return { heat, percentile: percentileOf(ranks, target.lowRank), relHeat, trend, samples: ranks.length, years };
}

/** 全省所有专业按热度排序（用于榜单/截图） */
export function rankMajorsByHeat(state, province, year, limit = 50) {
  const ranks = buildRankDistribution(state, province, year);
  if (ranks.length < 2) return [];
  const out = [];
  for (const item of Object.values(state.schools ?? {})) {
    if (item.province !== province) continue;
    for (const [major, recs] of Object.entries(item.majors ?? {})) {
      const r = recs.find((x) => Number(x.year) === Number(year));
      if (!r || !Number.isFinite(r.lowRank)) continue;
      const heat = heatOfRank(ranks, r.lowRank);
      if (heat == null) continue;
      out.push({ school: item.school, major, heat, rank: r.lowRank, volume: r.volume ?? null, year });
    }
  }
  return out.sort((a, b) => b.heat - a.heat).slice(0, limit);
}
