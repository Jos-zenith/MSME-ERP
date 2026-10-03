// Line-item editor (invoice items, payments, parts...). Built for keyboard-only billing:
//
//   Enter on the last cell   -> next row appears, cursor in its first cell (no mouse, no shortcut to remember)
//   Enter on an empty item   -> leave the grid and go on to the next part of the form
//   Alt+N  or  Insert        -> add a row below the current one
//   Alt+D  or  Ctrl+Delete   -> delete the current row
//   ↑ / ↓                    -> same column, previous / next row
//   quick-entry bar          -> scan a barcode or type "SUG1*3" + Enter: rows are appended TOP to BOTTOM in the
//                               order you enter them, and a repeated item just increases its quantity
import { h, toast } from './dom.js';
import { makeControl, lookupOptions } from './controls.js';
import { combobox } from './combobox.js';
import { t } from '../i18n.js';
import { newRow, rowIsBlank, makeScope, isBlank, fmtMoney, isComputed } from '../schema.js';
import { tryEvaluate, toNum } from '../formula.js';

const QTY_RE = /^(.*?)\s*(?:[*×]|\s[xX]\s)\s*(\d+(?:\.\d+)?)\s*$/;

/**
 * store, table, field (a `lines` field), getRows() -> live array, changed() -> parent recompute,
 * getData() -> whole draft (for preset formulas), onExit() -> move on to the next form control
 */
export function linesEditor({ store, table, field, getRows, changed, getData, onExit, readOnlyPresets = false }) {
  const cols = (field.columns || []);
  const visible = cols.filter((c) => !c.hidden);
  const editable = visible.filter((c) => !isComputed(c));
  const flow = (field.flow || editable.map((c) => c.id)).filter((id) => editable.some((c) => c.id === id));
  let cells = []; // cells[i][colId] = control
  const ctx = store.ctx();

  const tbody = h('tbody');
  const thead = h('thead', h('tr', h('th.rn', '#'), visible.map((c) => h('th', { class: `c-${c.type}` }, c.label)), h('th.rm')));
  const table_ = h('table.grid', { role: 'grid', 'aria-label': field.label }, thead, tbody);
  const wrap = h('div.grid-wrap', table_);

  const focusCell = (r, colId) => {
    const c = cells[r]?.[colId];
    const el = c?.focusEl;
    if (el) { el.focus(); if (el.select && el.tagName === 'INPUT') el.select(); return true; }
    return false;
  };

  function renderRows() {
    for (const row of cells) for (const c of Object.values(row)) c.destroy?.();
    const rows = getRows();
    cells = [];
    tbody.replaceChildren();
    rows.forEach((_, i) => {
      const rowCells = {};
      const tr = h('tr', { dataset: { r: i } }, h('td.rn', String(i + 1)));
      for (const col of visible) {
        const ctl = makeControl(store, col, {
          get: () => getRows()[i]?.[col.id],
          set: (v) => { const rr = getRows()[i]; if (rr) { rr[col.id] = v; changed(); } },
          compact: true, aria: `${col.label} ${i + 1}`,
          onPick: () => { const idx = flow.indexOf(col.id); focusCell(i, flow[idx + 1] || flow[idx]); },
        });
        rowCells[col.id] = ctl;
        tr.append(h('td', { class: `c-${col.type}`, dataset: { c: col.id } }, ctl.el));
      }
      tr.append(h('td.rm', h('button.icon-btn', { type: 'button', tabindex: '-1', 'aria-label': t('Delete row'), onclick: () => deleteRow(i) }, '✕')));
      tbody.append(tr);
      cells.push(rowCells);
    });
    sync();
  }

  function sync() {
    if (getRows().length !== cells.length) { renderRows(); return; }
    for (const row of cells) for (const c of Object.values(row)) c.sync();
  }

  function addRow(at) {
    const rows = getRows();
    const i = at === undefined ? rows.length : at;
    rows.splice(i, 0, newRow(field, ctx));
    changed();
    renderRows();
    focusCell(i, flow[0]);
    return i;
  }
  function deleteRow(i) {
    const rows = getRows();
    if (rows.length <= 1) rows.splice(0, rows.length, newRow(field, ctx)); else rows.splice(i, 1);
    changed();
    renderRows();
    focusCell(Math.min(i, getRows().length - 1), flow[0]);
  }

  function onEnter(r, colId) {
    const rows = getRows();
    const idx = flow.indexOf(colId);
    if (idx <= 0 && rowIsBlank(field, rows[r] || {}) && r === rows.length - 1 && field.columns.some((c) => c.type === 'lookup')) {
      onExit?.(); return;
    }
    if (idx >= 0 && idx < flow.length - 1) { focusCell(r, flow[idx + 1]); return; }
    if (r < rows.length - 1) { focusCell(r + 1, flow[0]); return; }
    if (rowIsBlank(field, rows[r] || {})) { onExit?.(); return; }
    addRow();
  }

  tbody.addEventListener('keydown', (e) => {
    const td = e.target.closest('td[data-c]');
    const tr = e.target.closest('tr[data-r]');
    if (!td || !tr) return;
    const r = +tr.dataset.r, c = td.dataset.c;
    const isTextArea = e.target.tagName === 'TEXTAREA';
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTextArea && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      onEnter(r, c);
    } else if ((e.altKey && (e.key === 'n' || e.key === 'N')) || e.key === 'Insert') {
      e.preventDefault(); addRow(r + 1);
    } else if ((e.altKey && (e.key === 'd' || e.key === 'D')) || (e.ctrlKey && e.key === 'Delete')) {
      e.preventDefault(); deleteRow(r);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey && !cells[r][c].isCombo && e.target.tagName !== 'SELECT') {
      const to = r + (e.key === 'ArrowDown' ? 1 : -1);
      if (cells[to] && focusCell(to, c)) e.preventDefault();
    }
  });

  // ---- quick-entry bar (scan / type code, Enter) --------------------------------------------------
  const itemCol = cols.find((c) => c.type === 'lookup');
  let quick = null, qty = 1;
  if (field.quickEntry && itemCol) {
    const refTable = store.table(itemCol.ref);
    quick = combobox({
      clearOnPick: true, className: 'cb-fill', ariaLabel: t('Quick entry'),
      placeholder: t('Quick entry: scan a barcode or type a code (e.g. SUG1*3) and press Enter'),
      getOptions: (q) => {
        const m = QTY_RE.exec(q);
        qty = m ? parseFloat(m[2]) : 1;
        return refTable ? lookupOptions(store, refTable, m ? m[1] : q) : [];
      },
      labelOf: () => '',
      onPick: (o) => addItem(o.id, qty),
    });
  }
  function addItem(itemId, n) {
    const rows = getRows();
    const qtyCol = cols.find((c) => c.id === (field.qtyColumn || 'qty'));
    let i = rows.findIndex((r) => r[itemCol.id] === itemId);
    if (i >= 0 && qtyCol) rows[i][qtyCol.id] = toNum(rows[i][qtyCol.id]) + n;
    else {
      const last = rows[rows.length - 1];
      if (last && isBlank(last[itemCol.id])) i = rows.length - 1;          // reuse an empty trailing row
      else { rows.push(newRow(field, ctx)); i = rows.length - 1; }         // otherwise append at the bottom
      rows[i][itemCol.id] = itemId;
      if (qtyCol) rows[i][qtyCol.id] = n;
    }
    changed();
    renderRows();
    const tr = tbody.children[i];
    tr?.classList.add('flash');
    tr?.scrollIntoView({ block: 'nearest' });
    setTimeout(() => tr?.classList.remove('flash'), 900);
  }

  // ---- presets ("Cash received" etc.) ----------------------------------------------------------------
  const presets = (field.quickAdd || []).map((p) => h('button.btn.small', {
    type: 'button',
    onclick: () => {
      const data = getData();
      const scope = makeScope(table, data, ctx);
      const row = newRow(field, ctx);
      for (const [k, v] of Object.entries(p.values || {})) {
        row[k] = typeof v === 'string' && v.startsWith('=') ? tryEvaluate(v.slice(1), scope, null) : v;
      }
      const amountCol = cols.find((c) => c.type === 'money');
      if (amountCol && toNum(row[amountCol.id]) <= 0) { toast(t('Nothing is due.')); return; }
      const rows = getRows();
      rows.push(row);
      changed();
      renderRows();
    },
  }, p.label));

  const foot = h('div.lines-foot',
    h('button.btn.small', { type: 'button', onclick: () => addRow() }, `＋ ${t('Add row')}`),
    presets,
    h('span.hint.kbd-hint', t('Enter ↵ next · Alt+N new row · Alt+D delete row')));

  const el = h('div.lines', quick ? h('div.quick', h('span.quick-ic', '⌁'), quick.el) : null, wrap, foot);
  if (!getRows().length) getRows().push(newRow(field, ctx));
  renderRows();
  return {
    el, sync,
    focusFirst() { if (quick) quick.focus(); else focusCell(0, flow[0]); },
    focusEl: quick?.input || null,
    destroy() { for (const row of cells) for (const c of Object.values(row)) c.destroy?.(); quick?.destroy(); },
  };
}
export { fmtMoney };
