/* フリマル商品データCSV コアロジック（ブラウザ・Node共用）
 * プライスター側（csv-core.js）と同じ方針：元ファイルのバイト列を保持し、
 * 変更したセルのバイト範囲だけを差し替える（CP932・改行コードを崩さない）。
 *
 * 列構成（22列）
 *  0 管理コード / 1 商品名 / 2 種類 / 3 数量 / 4 出品日時 / 5 発送までの日数
 *  6 商品ステータス(1非公開/2公開) / 7 販売価格 / 8 まとめて自動値下げ(on)
 *  9 自動値上げ時間帯 / 10 値上げ価格 / 11 赤字STOP / 12 原価 / 13 粗利
 *  14 粗利率 / 15 送料 / 16 手数料 / 17 利益 / 18 利益率
 *  19 SKU1_ID / 20 商品ID / 21 商品データの削除
 */
(function (root) {
  'use strict';
  const FM = {};
  const TD = new TextDecoder('shift_jis');

  FM.COL = {
    code: 0, name: 1, kind: 2, qty: 3, listedAt: 4, shipDays: 5,
    status: 6, price: 7, autoDown: 8, upTime: 9, upPrice: 10,
    akaji: 11, cost: 12, gross: 13, grossRate: 14, shipping: 15,
    fee: 16, profit: 17, profitRate: 18, skuId: 19, itemId: 20, del: 21,
  };
  FM.COLS = 22;

  FM.splitLines = function (u8) {
    const lines = [];
    let start = 0, i = 0, inQ = false;
    while (i < u8.length) {
      const b = u8[i];
      if (b === 0x22) { inQ = !inQ; i++; continue; }
      if (!inQ && b === 0x0a) {
        let end = i;
        if (end > start && u8[end - 1] === 0x0d) end--;
        lines.push({ start, end, fullEnd: i + 1 });
        start = i + 1;
      }
      i++;
    }
    if (start < u8.length) lines.push({ start, end: u8.length, fullEnd: u8.length });
    return lines;
  };

  FM.parseCells = function (u8, start, end) {
    const cells = [];
    let cs = start, i = start, inQ = false;
    while (i < end) {
      const b = u8[i];
      if (inQ) {
        if (b === 0x22) {
          if (i + 1 < end && u8[i + 1] === 0x22) { i += 2; continue; }
          inQ = false;
        }
        i++; continue;
      }
      if (b === 0x22) { inQ = true; i++; continue; }
      if (b === 0x2c) { cells.push({ start: cs, end: i }); cs = i + 1; }
      i++;
    }
    cells.push({ start: cs, end });
    return cells;
  };

  FM.cellValue = function (raw) {
    let s = raw;
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1);
    return s.replace(/""/g, '"');
  };

  /* ヘッダーは列名に改行を含むことがあるので、行数ではなく「列数22」で判定する。
   * ヘッダー行だけは引用符付き改行を含むため、行分割済みの先頭行から素直に読む。 */
  FM.parseFile = function (u8) {
    const lines = FM.splitLines(u8);
    if (!lines.length) throw new Error('空のファイルです');
    const headerCells = FM.parseCells(u8, lines[0].start, lines[0].end);
    if (headerCells.length < FM.COLS) {
      throw new Error('フリマルの商品データCSVではないようです（列数 ' + headerCells.length + '）');
    }
    const header = headerCells.map(function (r) {
      return FM.cellValue(TD.decode(u8.subarray(r.start, r.end))).replace(/^﻿/, '').split(/[\r\n]/)[0].trim();
    });
    if (header[0] !== '管理コード' || header[FM.COL.price] !== '販売価格') {
      throw new Error('フリマルの商品データCSVではないようです（先頭列：' + header[0] + '）');
    }

    const items = [];
    for (let li = 1; li < lines.length; li++) {
      const cells = FM.parseCells(u8, lines[li].start, lines[li].end);
      if (cells.length < FM.COLS) continue;
      const v = function (idx) { return FM.cellValue(TD.decode(u8.subarray(cells[idx].start, cells[idx].end))); };
      const num = function (idx) { const n = parseInt(String(v(idx)).replace(/[^0-9-]/g, ''), 10); return isNaN(n) ? 0 : n; };
      const itemId = v(FM.COL.itemId).trim();
      if (!itemId) continue;   // 商品IDが行の一意キー（管理コードは任意項目で空のことがある）
      const listedAt = v(FM.COL.listedAt).trim();
      items.push({
        line: li,
        id: itemId,
        code: v(FM.COL.code).trim(),
        name: v(FM.COL.name),
        qty: num(FM.COL.qty),
        listedAt: listedAt,
        dateStr: FM.dateFromListed(listedAt),
        status: v(FM.COL.status).trim(),      // '1'非公開 / '2'公開
        price: num(FM.COL.price),
        autoDown: v(FM.COL.autoDown).trim(),  // 'on' で自動値下げ有効
        akaji: num(FM.COL.akaji),
        cost: num(FM.COL.cost),
        gross: num(FM.COL.gross),
        shipping: num(FM.COL.shipping),
        fee: num(FM.COL.fee),
        profit: num(FM.COL.profit),
      });
    }
    return { header: header, lines: lines, items: items };
  };

  // '2026/07/26 16:21:17' → '20260726'
  FM.dateFromListed = function (s) {
    const m = String(s).match(/^(\d{4})\/(\d{2})\/(\d{2})/);
    return m ? m[1] + m[2] + m[3] : null;
  };

  FM.STATUS_LABEL = { '1': '非公開', '2': '公開中' };

  /* 書き出し：changes = { 商品ID: {price?, akaji?, autoDown?} }
   * onlyChanged=true なら「ヘッダー＋変更行だけ」を出す（フリマル側の処理が軽くなる）*/
  FM.buildExport = function (u8, parsed, changes, onlyChanged) {
    const enc = new TextEncoder();
    const dec = TD;
    const parts = [];
    const applied = [];
    const missing = {};
    Object.keys(changes).forEach(function (k) { missing[k] = 1; });

    parsed.lines.forEach(function (line, li) {
      if (li === 0) { parts.push(u8.subarray(line.start, line.fullEnd)); return; }
      const cells = FM.parseCells(u8, line.start, line.end);
      if (cells.length < FM.COLS) { if (!onlyChanged) parts.push(u8.subarray(line.start, line.fullEnd)); return; }
      const key = FM.cellValue(dec.decode(u8.subarray(cells[FM.COL.itemId].start, cells[FM.COL.itemId].end))).trim();
      const c = changes[key];
      if (!c) { if (!onlyChanged) parts.push(u8.subarray(line.start, line.fullEnd)); return; }
      delete missing[key];

      const repl = [];
      if (c.price != null && c.price !== '') repl.push({ idx: FM.COL.price, val: String(c.price) });
      if (c.akaji != null && c.akaji !== '') repl.push({ idx: FM.COL.akaji, val: String(c.akaji) });
      if (c.autoDown != null) repl.push({ idx: FM.COL.autoDown, val: c.autoDown ? 'on' : '' });
      if (!repl.length) { if (!onlyChanged) parts.push(u8.subarray(line.start, line.fullEnd)); return; }
      repl.sort(function (a, b) { return a.idx - b.idx; });

      let pos = line.start;
      repl.forEach(function (r) {
        const cell = cells[r.idx];
        parts.push(u8.subarray(pos, cell.start));
        parts.push(enc.encode(r.val));
        pos = cell.end;
      });
      const tail = u8.subarray(pos, line.fullEnd);
      parts.push(tail);
      if (onlyChanged && (tail.length === 0 || tail[tail.length - 1] !== 0x0a)) parts.push(enc.encode('\r\n'));
      applied.push(key);
    });

    let total = 0;
    parts.forEach(function (p) { total += p.length; });
    const out = new Uint8Array(total);
    let off = 0;
    parts.forEach(function (p) { out.set(p, off); off += p.length; });
    return { bytes: out, applied: applied, missing: Object.keys(missing), changeCount: applied.length };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = FM;
  else root.FuriCore = FM;
})(typeof self !== 'undefined' ? self : this);
