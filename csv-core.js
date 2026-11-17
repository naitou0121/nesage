/* プライスターCSV コアロジック（ブラウザ・Node共用）
 * 方針：元ファイルのバイト列をそのまま保持し、書き出し時は akaji セルの
 * バイト範囲だけを差し替える。="..." 形式・Shift-JIS・改行コードを一切変換しない。
 * CP932の2バイト目は 0x40 以上なので、0x22(") 0x2C(,) 0x0A 0x0D をASCII規則で
 * 走査してもマルチバイト文字を誤認しない。
 */
(function (root) {
  'use strict';
  const CORE = {};
  const TD = new TextDecoder('shift_jis');

  // 行分割（バイト範囲）。content: 改行を含まない範囲 / full: 改行を含む範囲
  CORE.splitLines = function (u8) {
    const lines = [];
    let start = 0;
    let i = 0;
    let inQ = false;
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

  // 1行内のセル分割（バイト範囲・引用符/=" を含む生の範囲）
  CORE.parseCells = function (u8, start, end) {
    const cells = [];
    let cs = start;
    let i = start;
    let inQ = false;
    while (i < end) {
      const b = u8[i];
      if (inQ) {
        if (b === 0x22) {
          if (i + 1 < end && u8[i + 1] === 0x22) { i += 2; continue; }
          inQ = false;
        }
        i++;
        continue;
      }
      if (b === 0x22) { inQ = true; i++; continue; }
      if (b === 0x2c) { cells.push({ start: cs, end: i }); cs = i + 1; }
      i++;
    }
    cells.push({ start: cs, end });
    return cells;
  };

  CORE.decodeRange = function (u8, r) {
    return TD.decode(u8.subarray(r.start, r.end));
  };

  // 生セル文字列 → 値（="..." / "..." を剥がし "" を戻す）
  CORE.cellValue = function (raw) {
    let s = raw;
    if (s.charCodeAt(0) === 0x3d) s = s.slice(1); // leading =
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1);
    return s.replace(/""/g, '"');
  };

  // SKUから仕入れ日 YYYYMMDD を推定（SKU内の最初の有効な8桁日付）
  // 例: 2026042317 / i20250913140 / pr_1302058_20250709_27129319_0001
  CORE.skuDate = function (sku) {
    const re = /20\d{6}/g;
    let m;
    while ((m = re.exec(String(sku))) !== null) {
      const s = m[0];
      const mo = +s.slice(4, 6);
      const d = +s.slice(6, 8);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return s;
    }
    return null;
  };

  // 全体解析：ヘッダ・列index・行範囲・商品配列
  CORE.parseFile = function (u8) {
    const lines = CORE.splitLines(u8);
    if (!lines.length) throw new Error('空のファイルです');
    const headerCells = CORE.parseCells(u8, lines[0].start, lines[0].end);
    const header = headerCells.map((r) => CORE.cellValue(CORE.decodeRange(u8, r)).replace(/^﻿/, ''));
    const col = {};
    header.forEach((h, i) => { col[h.trim()] = i; });
    for (const need of ['SKU', 'title', 'price', 'akaji', 'condition']) {
      if (!(need in col)) throw new Error('プライスターのCSVではないようです（' + need + ' 列なし）');
    }
    const items = [];
    for (let li = 1; li < lines.length; li++) {
      const cells = CORE.parseCells(u8, lines[li].start, lines[li].end);
      if (cells.length < header.length) continue;
      const v = (name) => (name in col ? CORE.cellValue(CORE.decodeRange(u8, cells[col[name]])) : '');
      const num = (name) => { const n = parseInt(v(name), 10); return isNaN(n) ? 0 : n; };
      const sku = v('SKU');
      if (!sku) continue;
      items.push({
        line: li,
        sku,
        asin: v('ASIN'),
        title: v('title'),
        number: num('number'),
        price: num('price'),
        cost: num('cost'),
        akaji: num('akaji'),
        takane: num('takane'),
        condition: v('condition').trim(),
        priceTrace: v('priceTrace').trim(),
        profit: num('profit'),          // プライスターが出した粗利（表示には使わない・見比べ用）
        fee: num('amazon-fee'),         // Amazon手数料（販売手数料＋成約料＋配送代行料・税込）
        shipping: num('shipping-price'),
        dateStr: CORE.skuDate(sku),
      });
    }
    return { header, col, lines, items };
  };

  /* 粗利はアプリで計算する（プライスターの profit 列は使わない）
   *   粗利 ＝ 出品価格 − 仕入れ値 − Amazon手数料 − 送料
   * Amazon手数料はプライスターの amazon-fee 列（商品ごとのサイズ込みの額）。
   * 価格を打ち替えた時は、価格に比例する分だけ手数料を動かす：
   *   販売手数料 15.4% × 消費税1.1 ＝ 16.94%（2026-09〜11の出荷済み注文838件・在庫672件の実測。
   *   15%では合わず 15.4% で配送代行料が 288/318/420… の料金表の値にそろう）
   *   配送代行料は 1,000円以下で66円安い（1,000円をまたいだ時だけ足し引き）
   * 仕入れ値が 0 の商品は粗利を出さない（0円仕入れとして大きな粗利に見せない）。 */
  CORE.FEE_RATE = 0.1694;
  CORE.feeAt = function (item, price) {
    if (!(item.fee > 0) || !(item.price > 0) || !(price > 0)) return null;
    if (price === item.price) return item.fee;
    let fee = item.fee + Math.round((price - item.price) * CORE.FEE_RATE);
    if (item.price > 1000 && price <= 1000) fee -= 66;
    else if (item.price <= 1000 && price > 1000) fee += 66;
    return fee;
  };
  // 戻り値 { fee, profit, noCost } ／ 手数料が取れていない行は null
  CORE.profitAt = function (item, price) {
    const fee = CORE.feeAt(item, price);
    if (fee == null) return null;
    const noCost = !(item.cost > 0);
    return { fee, noCost, profit: noCost ? null : price - item.cost - fee - (item.shipping || 0) };
  };

  CORE.CONDITION_LABEL = {
    '1': '中古・ほぼ新品', '2': '中古・非常に良い', '3': '中古・良い', '4': '中古・可',
    '5': 'コレクター・ほぼ新品', '6': 'コレクター・非常に良い', '7': 'コレクター・良い', '8': 'コレクター・可',
    '10': '新品', '11': '新品',
  };
  CORE.isCollector = function (condition) {
    return ['5', '6', '7', '8'].indexOf(String(condition).trim()) !== -1;
  };
  CORE.PRICETRACE_LABEL = {
    '0': '追従なし', '1': 'FBA状態合わせ', '2': '状態合わせ', '3': 'FBA最安値', '4': '最安値', '5': 'カート価格',
  };

  // 商品ごとの値下げ対象フィールドを判定
  // 追従なし（priceTrace=0）や最低価格未設定は販売価格を直接下げる。それ以外は最低価格(akaji)。
  CORE.targetField = function (item) {
    return (item.priceTrace === '0' || item.akaji === 0) ? 'price' : 'akaji';
  };

  // 書き出し：changes = { sku: { price?: n, akaji?: n } } を反映した全行CSV（元バイト保持）
  CORE.buildExport = function (u8, parsed, changes) {
    const enc = new TextEncoder(); // 差し替えセルはASCII数字のみ
    const lineToNew = {};
    let changeCount = 0;
    for (const item of parsed.items) {
      const c = changes[item.sku];
      if (c && ['price', 'akaji', 'takane', 'priceTrace'].some(function (f) { return c[f] != null && c[f] !== ''; })) {
        lineToNew[item.line] = c;
        changeCount++;
      }
    }
    const parts = [];
    parsed.lines.forEach(function (line, li) {
      if (!(li in lineToNew)) {
        parts.push(u8.subarray(line.start, line.fullEnd));
        return;
      }
      const c = lineToNew[li];
      const cells = CORE.parseCells(u8, line.start, line.end);
      // 差し替え対象セルを列indexの昇順で並べて前から出力
      const repl = [];
      ['price', 'akaji', 'takane', 'priceTrace'].forEach(function (f) {
        if (c[f] != null && c[f] !== '') repl.push({ idx: parsed.col[f], val: c[f] });
      });
      repl.sort(function (a, b) { return a.idx - b.idx; });
      let pos = line.start;
      repl.forEach(function (r) {
        const cell = cells[r.idx];
        parts.push(u8.subarray(pos, cell.start));
        parts.push(enc.encode('"' + String(r.val) + '"'));
        pos = cell.end;
      });
      parts.push(u8.subarray(pos, line.fullEnd));
    });
    let total = 0;
    parts.forEach((p) => { total += p.length; });
    const out = new Uint8Array(total);
    let off = 0;
    parts.forEach((p) => { out.set(p, off); off += p.length; });
    return { bytes: out, changeCount };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  else root.CSVCore = CORE;
})(typeof self !== 'undefined' ? self : this);
