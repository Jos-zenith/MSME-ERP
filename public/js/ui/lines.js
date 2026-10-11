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
import { cameraScanSupported, openScanner } from './scanner.js';
import { icon } from './icons.js';
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
  // the line's own total (the last calculated money column): the one figure a small screen must always show
  const totalId = field.totalColumn || [...visible].reverse().find((c) => isComputed(c) && c.type === 'money')?.id;
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
        tr.append(h('td', { class: `c-${col.type}${isComputed(col) ? ' c-calc' : ''}${col.id === totalId ? ' c-total' : ''}`, dataset: { c: col.id, label: col.label } }, ctl.el));
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
    paintUsual();
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
  const canAddItems = !!itemCol && (store.canAddTo ? store.canAddTo(itemCol.ref) : true);
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
      // a code that is not in the items yet (a new product scanned for the first time): add it without retyping the code
      onCreate: canAddItems ? (q) => addNewItem(QTY_RE.exec(q)?.[1] || q, qty) : null,
      createLabel: (q) => t('New item with code {q}', { q: QTY_RE.exec(q)?.[1] || q }),
    });
  }
  /** Opens the new-item form with the scanned / typed code already filled in, then puts the item on the bill. */
  async function addNewItem(code, n = 1) {
    const refTable = store.table(itemCol.ref);
    const isBarcode = /^\d{8,14}$/.test(code) && refTable.fields.some((f) => f.id === 'barcode');
    const codeField = isBarcode ? 'barcode' : refTable.fields.find((f) => f.id === 'code') ? 'code' : refTable.titleField;
    const { openRecordModal } = await import('./form.js');
    openRecordModal(store, refTable.id, { [codeField]: code }, (rec) => { addItem(rec.id, n); quick?.focus(); });
  }
  /** Exact code / barcode match only: a camera misread must never add the wrong item. */
  function itemByCode(code) {
    const refTable = store.table(itemCol.ref);
    const ids = refTable.searchFields?.length ? refTable.searchFields : [refTable.titleField];
    const c = code.toLowerCase();
    return store.records(refTable.id).find((r) => ids.some((id) => String(r.data[id] ?? '').trim().toLowerCase() === c)) || null;
  }
  const scanBtn = quick && cameraScanSupported() ? h('button.btn.small.scan-btn', { type: 'button', 'aria-label': t('Scan with camera'), title: t('Scan with camera'), onclick: () => openScanner({
    title: t('Scan with camera'),
    onCode: (code) => {
      const rec = itemByCode(code);
      if (!rec) return { unknown: true, add: canAddItems ? () => addNewItem(code) : null };
      addItem(rec.id, 1);
      return { label: String(rec.data[store.table(itemCol.ref).titleField] ?? code) };
    },
  }) }, icon('camera', { size: 18 })) : null;
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

  // ---- "usually buys" strip: one tap adds what this customer (or the shop) buys most --------------------
  const partyField = table.fields.find((f) => f.type === 'lookup');
  const usual = quick ? h('div.usual', { hidden: true }) : null;
  let usualKey = null;
  function paintUsual() {
    if (!usual || !store.usualLines) return;
    const data = getData();
    const partyId = partyField ? data[partyField.id] || '' : '';
    const inBill = new Set(getRows().map((r) => r[itemCol.id]).filter(Boolean));
    const key = `${partyId}|${[...inBill].join(',')}|${store.count(table.id)}`;
    if (key === usualKey) return;
    usualKey = key;
    const u = store.usualLines(table, field, partyField, partyId);
    const itemTable = store.table(itemCol.ref);
    const party = partyId && partyField ? store.getRecord(partyField.ref, partyId) : null;
    const partyTable = partyField ? store.table(partyField.ref) : null;
    const name = (id) => { const r = store.getRecord(itemCol.ref, id); return r ? String(r.data[itemTable.titleField] ?? '') : ''; };
    const qtyOf = (x) => toNum(x.qty) || 1;
    const chips = u.items.filter((x) => !inBill.has(x.id)).map((x) => h('button.chip.usual-chip', { type: 'button', onclick: () => addItem(x.id, qtyOf(x)) },
      `＋ ${name(x.id)}`, qtyOf(x) !== 1 ? h('span.count', `×${qtyOf(x)}`) : null));
    const last = u.last;
    const lastRows = last ? (last.data[field.id] || []).filter((r) => r[itemCol.id] && store.getRecord(itemCol.ref, r[itemCol.id])) : [];
    const repeat = lastRows.length && !inBill.size ? h('button.chip.repeat-chip', { type: 'button', onclick: () => {
      for (const r of lastRows) addItem(r[itemCol.id], toNum(r[field.qtyColumn || 'qty']) || 1);
      toast(t('Added {n} items from the last bill.', { n: lastRows.length }));
    } }, `↻ ${t('Repeat last bill')}`, h('span.count', `${lastRows.length} · ${last.data[table.titleField] || ''}`)) : null;
    usual.hidden = !chips.length && !repeat;
    usual.replaceChildren(
      h('span.usual-lbl', party && partyTable ? t('{name} usually buys', { name: String(party.data[partyTable.titleField] ?? '') }) : t('Popular')),
      repeat, chips);
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
    h('button.btn.small', { type: 'button', onclick: () => addRow() }, icon('plus', { size: 14 }), t('Add row')),
    presets,
    h('span.hint.kbd-hint', t('Enter ↵ next · Alt+N new row · Alt+D delete row')));

  const el = h('div.lines', quick ? h('div.quick', h('span.quick-ic', icon('scan', { size: 16 })), quick.el, scanBtn) : null, usual, wrap, foot);
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
