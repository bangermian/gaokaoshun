/**
 * 视图层：只负责把数据画到 DOM 上，不做任何业务计算。
 * 所有函数都直接操作本页固定 id 的元素（单页应用，无需抽象）。
 */

import { COLORS } from './config.js';
import { escapeHtml, formatNumber } from './utils.js';

export const $ = (id) => document.getElementById(id);

/* ---------------- 顶部状态 ---------------- */

export function setStatus(text, variant = '') {
  const bar = document.querySelector('.status-bar');
  const el = $('statusText');
  if (el) el.textContent = text;
  if (bar) {
    bar.classList.toggle('is-warn', variant === 'warn');
    bar.classList.toggle('is-ok', variant === 'ok');
  }
}

export function setStatusCount(text) {
  const el = $('statusCount');
  if (el) el.textContent = text;
}

/* ---------------- Toast ---------------- */

export function toast(message, type = 'info', duration = 3200) {
  const host = $('toastHost');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast${type === 'ok' ? ' toast--ok' : type === 'err' ? ' toast--err' : ''}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(16px)';
    setTimeout(() => node.remove(), 260);
  }, duration);
}

/* ---------------- 弹窗 ---------------- */

export function openModal(id) {
  const el = $(id);
  if (el) el.hidden = false;
}

export function closeModal(id) {
  const el = $(id);
  if (el) el.hidden = true;
}

/* ---------------- 空状态 ---------------- */

const DEFAULT_EMPTY_DESC = '把 Excel / CSV 放进项目的 <code>data/</code> 目录，刷新页面就会自动加载。<br>也可以点右上角「加载数据」手动选择文件夹。';

/**
 * @param {boolean} visible
 * @param {string} [message] 自定义说明（不传则用默认的"怎么加载数据"）
 */
export function setEmptyState(visible, message) {
  const el = $('emptyState');
  if (!el) return;
  el.hidden = !visible;
  const desc = el.querySelector('.empty-desc');
  const title = el.querySelector('.empty-title');
  if (title) title.textContent = message ? '这个组合没有数据' : '还没有数据';
  if (desc) desc.innerHTML = message || DEFAULT_EMPTY_DESC;
}

/* ---------------- 下拉框 ---------------- */

/**
 * 重建下拉选项。
 * @param {string} selectId
 * @param {Array<{value:string,label:string}>} options
 * @param {string} selected
 */
export function fillSelect(selectId, options, selected) {
  const select = $(selectId);
  if (!select) return;
  select.innerHTML = options
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join('');
  if (selected !== undefined && selected !== null && options.some((option) => option.value === selected)) {
    select.value = selected;
  }
}

/* ---------------- 数据列表 ---------------- */

/**
 * @param {string} containerId
 * @param {Array<{year:number, text:string, meta?:string, color?:string, deletable?:boolean}>} rows
 * @param {(year:number)=>void} onDelete
 */
export function renderDataList(containerId, rows, onDelete) {
  const container = $(containerId);
  if (!container) return;

  if (!rows || rows.length === 0) {
    container.innerHTML = '<div class="data-empty">暂无数据</div>';
    return;
  }

  container.innerHTML = rows.map((row) => {
    const colorStyle = row.color ? ` style="color:${row.color}"` : '';
    const deleteButton = row.deletable
      ? `<button class="data-del" data-year="${row.year}" title="删除该年数据">删除</button>`
      : '';
    const meta = row.meta ? `<span class="data-meta">${escapeHtml(row.meta)}</span>` : '';
    return `<div class="data-item">
      <span class="data-year">${row.year} 年</span>
      <span class="data-value"${colorStyle}>${escapeHtml(row.text)}</span>
      ${meta}
      ${deleteButton}
    </div>`;
  }).join('');

  if (typeof onDelete === 'function') {
    container.querySelectorAll('.data-del').forEach((button) => {
      button.addEventListener('click', () => onDelete(Number(button.dataset.year)));
    });
  }
}

/* ---------------- 信息条 ---------------- */

export function resetInfoBar() {
  ['currentName', 'currentPrice', 'changeRate', 'currentVolume', 'historyHigh', 'historyLow',
    'currentDifficulty', 'relativeStrength', 'majorHeat', 'ruankeScore'].forEach((id) => {
    const el = $(id);
    if (el) el.textContent = '-';
  });
  const change = $('changeRate');
  if (change) change.className = 'value';
  const price = $('currentPrice');
  if (price) price.className = 'value';
  const relative = $('relativeStrength');
  if (relative) relative.className = 'value';
  const difficulty = $('currentDifficulty');
  if (difficulty) difficulty.className = 'value';
}

/**
 * @param {{name:string, valueLabel:string, value:string, change?:{text:string,tone:string},
 *          volume:string, high:string, low:string,
 *          difficulty?:{text:string}, relative?:{text:string, tone:string}}} info
 */
export function renderInfoBar(info) {
  const set = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };
  set('currentName', info.name || '-');
  set('currentValueLabel', info.valueLabel || '最新值');
  set('currentPrice', info.value ?? '-');
  set('currentVolume', info.volume ?? '-');
  set('historyHigh', info.high ?? '-');
  set('historyLow', info.low ?? '-');
  set('currentDifficulty', info.difficulty?.text ?? '-');

  const change = $('changeRate');
  if (change) {
    change.textContent = info.change?.text ?? '-';
    change.className = `value ${info.change?.tone ?? ''}`.trim();
  }
  const price = $('currentPrice');
  if (price) price.className = `value ${info.change?.tone ?? ''}`.trim();

  const relative = $('relativeStrength');
  if (relative) {
    relative.textContent = info.relative?.text ?? '-';
    relative.className = `value ${info.relative?.tone ?? ''}`.trim();
  }
}

/* ---------------- 标签页 ---------------- */

export function bindTabs(onSwitch) {
  const tabs = [...document.querySelectorAll('.tab[data-tab]')];
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      tabs.forEach((item) => item.classList.toggle('is-active', item === tab));
      document.querySelectorAll('.tab-content').forEach((section) => {
        section.classList.toggle('is-active', section.id === `${name}-content`);
      });
      onSwitch?.(name);
    });
  });
}

/* ---------------- 个股专业下拉 ---------------- */

export function setMajorOptions(majors, selected = '__all__') {
  const select = $('majorSelect');
  const group = $('major-select-group');
  if (!select) return;
  select.innerHTML = ['<option value="__all__">全部专业（院校整体）</option>']
    .concat(majors.map((major) => `<option value="${escapeHtml(major)}">${escapeHtml(major)}</option>`))
    .join('');
  select.value = majors.includes(selected) ? selected : '__all__';
  if (group) group.classList.toggle('is-hidden', majors.length === 0);
}

/* ---------------- 学校提示 ---------------- */

export function setSchoolOptions(schools) {
  const list = $('schoolOptions');
  if (!list) return;
  list.innerHTML = schools
    .map((item) => `<option value="${escapeHtml(item.school)}">${escapeHtml(item.province)}</option>`)
    .join('');
}

/* ---------------- 颜色小工具 ---------------- */

export function toneColor(tone) {
  if (tone === 'up') return COLORS.up;
  if (tone === 'down') return COLORS.down;
  return COLORS.neutral;
}

export { formatNumber };
