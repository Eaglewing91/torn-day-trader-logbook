// ==UserScript==
// @name         Torn Day Trader Logbook (Experimental)
// @namespace    https://torn.com/
// @version      1.1.3-exp
// @description  Draggable panel for Torn stocks showing BUY/SELL logs (5510/5511) for 7/14/30 days plus custom date range. Sticky position, loading bar, average-cost ledger, tickers. Columns: Buy Price, Sell Price, Shares, Gross (Sell), Fee (0.10%), Total Buy, Total Sell, Profit. BUY rows show “N/A” in Total Sell and “—” in Gross (Sell). Click rows to highlight (Ctrl/Cmd). Inline manual BUY price for old SELLs. Requires Full Access API key. Made by Eaglewing [571041].
// @match        https://www.torn.com/page.php?sid=stocks*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ------------------ Config ------------------
  const API_BASE = 'https://api.torn.com';
  const TITLE = 'Torn Day Trader Logbook';

  const KEY_API         = 'tdtl_api_key_v111exp';
  const KEY_LAST_RANGE  = 'tdtl_last_range_v111exp';   // '7' | '14' | '30'
  const KEY_CUSTOM_FROM = 'tdtl_custom_from_v111exp';  // 'YYYY-MM-DD' or ''
  const KEY_CUSTOM_TO   = 'tdtl_custom_to_v111exp';    // 'YYYY-MM-DD' or ''
  const KEY_STOCK_MAP   = 'tdtl_stock_map_v111exp';    // cache: stock id -> acronym/name
  const KEY_POS         = 'tdtl_panel_pos_v111exp';    // { left, top }
  const KEY_MANUAL      = 'tdtl_manual_buys_v111exp';  // { [sellLogId]: { buyPrice:number, ts:number } }

  // Persistent log cache (deduped by log id) + coverage tracking (merged intervals)
  const KEY_LOG_CACHE   = 'tdtl_log_cache_v111exp';    // { [logId]: logObjWithId }
  const KEY_COVERAGE    = 'tdtl_log_cov_v111exp';      // Array<[fromTs,toTs]> inclusive


  const MAX_PAGES = 350;
  const MAX_LOGS  = 50000;

  const TYPE_BUY   = 5510;
  const TYPE_SELL  = 5511;

  // ------------------ Utils -------------------
  const s = (x) => (x == null ? '' : String(x));
  const unixNow = () => Math.floor(Date.now()/1000);
  const daysAgoUnix = (days) => unixNow() - days * 86400;
  const asDate = (ts) =>
    new Date(ts*1000).toLocaleString(undefined,{
      year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'
    });

  // Date input helpers (local time)
  function dateStrToUnixStart(dStr){
    // YYYY-MM-DD -> local start of day
    const d = new Date(dStr + 'T00:00:00');
    return Math.floor(d.getTime()/1000);
  }
  function dateStrToUnixEnd(dStr){
    // YYYY-MM-DD -> local end of day
    const d = new Date(dStr + 'T23:59:59');
    return Math.floor(d.getTime()/1000);
  }

  function notify(text){
    try { GM_notification({ title: TITLE, text, timeout: 3000 }); } catch { console.log(text); }
  }

  const price2 = (n)=> (typeof n==='number' && isFinite(n))
    ? n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})
    : '—';
  const money0 = (n)=> (typeof n==='number' && isFinite(n))
    ? '$' + n.toLocaleString(undefined,{maximumFractionDigits:0})
    : '—';
  const intFmt = (n)=> (typeof n==='number' && isFinite(n)) ? n.toLocaleString(undefined) : '—';

  // Manual cache helpers
  function getManualMap(){
    const obj = GM_getValue(KEY_MANUAL, {});
    if (obj && typeof obj === 'object') return obj;
    return {};
  }
  function setManualBuy(sellLogId, buyPrice){
    const map = getManualMap();
    if (buyPrice == null || !isFinite(buyPrice) || buyPrice <= 0) {
      delete map[sellLogId];
    } else {
      map[sellLogId] = { buyPrice: Number(buyPrice), ts: unixNow() };
    }
    GM_setValue(KEY_MANUAL, map);
  }
  function clearAllManual(){
    GM_setValue(KEY_MANUAL, {});
  }

  // ------------------ Log cache + coverage ------------------
  function getLogCache(){
    const obj = GM_getValue(KEY_LOG_CACHE, {});
    return (obj && typeof obj === 'object') ? obj : {};
  }
  function setLogCache(obj){
    GM_setValue(KEY_LOG_CACHE, obj);
  }
  function getCoverage(){
    const cov = GM_getValue(KEY_COVERAGE, []);
    return Array.isArray(cov) ? cov : [];
  }
  function setCoverage(cov){
    GM_setValue(KEY_COVERAGE, cov);
  }
  function normalizeCoverage(cov){
    // cov: Array<[from,to]> inclusive
    const items = (Array.isArray(cov) ? cov : [])
      .map(x => [Number(x?.[0]), Number(x?.[1])])
      .filter(([a,b]) => isFinite(a) && isFinite(b))
      .map(([a,b]) => a<=b ? [a,b] : [b,a])
      .sort((x,y)=> x[0]-y[0] || x[1]-y[1]);

    const merged = [];
    for (const [a,b] of items){
      if (!merged.length) { merged.push([a,b]); continue; }
      const last = merged[merged.length-1];
      if (a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else merged.push([a,b]);
    }
    return merged;
  }
  function addCoverage(from, to){
    const cov = normalizeCoverage([...getCoverage(), [from,to]]);
    setCoverage(cov);
    return cov;
  }
  function subtractIntervals(reqFrom, reqTo, cov){
    // returns missing intervals within [reqFrom, reqTo] not covered by cov
    const missing = [];
    let cursor = reqFrom;
    const norm = normalizeCoverage(cov);
    for (const [a,b] of norm){
      if (b < cursor) continue;
      if (a > reqTo) break;
      if (a > cursor) missing.push([cursor, Math.min(reqTo, a-1)]);
      cursor = Math.max(cursor, b+1);
      if (cursor > reqTo) break;
    }
    if (cursor <= reqTo) missing.push([cursor, reqTo]);
    return missing.filter(([a,b]) => a<=b);
  }

  async function ensureRangeCached(key, from, to, statusEl){
    // Cache-aware fetch: only pull missing sub-ranges for [from,to]
    const cov = getCoverage();
    const missing = subtractIntervals(from, to, cov);
    if (!missing.length) return;

    let cache = getLogCache();

    for (let i=0; i<missing.length; i++){
      const [mFrom, mTo] = missing[i];
      if (statusEl) statusEl.textContent = `Fetching missing logs ${i+1}/${missing.length}… (${asDate(mFrom)} → ${asDate(mTo)})`;

      const { all, lastStatus } = await fetchLogsWindow(key, mFrom, mTo);
      // Merge into cache
      for (const entry of all){
        if (entry && entry.id && !cache[entry.id]) cache[entry.id] = entry;
      }
      setLogCache(cache);
      addCoverage(mFrom, mTo);

      if (statusEl) statusEl.textContent = `Fetched ${all.length} logs (${lastStatus}). Cached coverage updated.`;
    }
  }

  function getCachedLogsInRange(from, to){
    const cache = getLogCache();
    return Object.values(cache).filter(l => {
      const ts = l?.timestamp;
      return typeof ts === 'number' && ts >= from && ts <= to;
    });
  }

  // Ledger context helper: include prior BUY/SELL events so SELLs inside the
  // selected range can resolve a buy price / average cost basis correctly.
  function getCachedLogsBefore(ts){
    const cache = getLogCache();
    return Object.values(cache).filter(l => {
      const t = l?.timestamp;
      return typeof t === 'number' && t < ts;
    });
  }

  function clearLogCacheWithCoverage(){
    GM_setValue(KEY_LOG_CACHE, {});
    GM_setValue(KEY_COVERAGE, []);
  }


  // ------------------ Styles -------------------
  GM_addStyle(`
    .tdtl-wrap{position:fixed;z-index:999999;right:20px;bottom:20px;width:1180px;max-height:82vh;
      background:#0b0e13;color:#f5f7fa;border:1px solid #2b2f36;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.6);
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
    .tdtl-header{cursor:move;padding:10px 12px;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:space-between;
      background:#10151d;border-bottom:1px solid #2b2f36;border-radius:10px 10px 0 0;color:#ffffff}
    .tdtl-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid #2b2f36;background:#0e141d}
    .tdtl-btn{background:#1f2a3a;color:#ffffff;border:1px solid #4a5a76;padding:6px 10px;border-radius:8px;font-size:12px;cursor:pointer;transition:.1s ease}
    .tdtl-btn:hover{background:#2a3a54}
    .tdtl-btn.active{background:#4d7cff;border-color:#93b4ff;box-shadow:0 0 0 2px rgba(147,180,255,.25) inset, 0 0 12px rgba(77,124,255,.25)}
    .tdtl-input{background:#0b0e13;color:#ffffff;border:1px solid #2b2f36;border-radius:6px;padding:6px 8px;font-size:13px;width:300px}
    .tdtl-date{background:#0b0e13;color:#ffffff;border:1px solid #2b2f36;border-radius:6px;padding:6px 8px;font-size:12px;width:140px}
    .tdtl-diagnostics{padding:8px 12px;border-bottom:1px solid #2b2f36;background:#0e141d}
    .tdtl-progress{position:relative;width:100%;height:8px;background:#1a2230;border-radius:6px;overflow:hidden;display:none}
    .tdtl-progress.active{display:block}
    .tdtl-progress-bar{position:absolute;top:0;left:-40%;width:40%;height:100%;
      background:linear-gradient(90deg,#3b82f6,#60a5fa,#93c5fd)}
    @keyframes tdtl-indeterminate{0%{left:-40%}100%{left:100%}}
    .tdtl-progress.active .tdtl-progress-bar{animation:tdtl-indeterminate 1.15s linear infinite}
    .tdtl-body{overflow:auto;max-height:calc(82vh - 206px)}
    .tdtl-summary{padding:8px 12px;background:#0e141d;border-bottom:1px solid #2b2f36;display:flex;gap:16px;flex-wrap:wrap}
    .tdtl-summary .card{background:#10151d;border:1px solid #2b2f36;border-radius:8px;padding:8px 10px;min-width:160px}
    .tdtl-table{width:100%;border-collapse:collapse;font-size:13.5px;color:#ffffff}
    .tdtl-table th,.tdtl-table td{padding:8px;border-bottom:1px solid #232a34;text-align:left;vertical-align:middle;background:#0b0e13}
    .tdtl-table th{position:sticky;top:0;background:#10151d;z-index:1;color:#ffffff}
    .tdtl-wrap, .tdtl-wrap * { color: #f5f7fa !important; }
    .tdtl-pill{display:inline-block;padding:2px 6px;border-radius:6px;font-weight:700}
    .tdtl-buy{background:#0d3a23;color:#9cf9be;border:1px solid #2a6a47}
    .tdtl-sell{background:#3a1d1d;color:#ffb4b4;border:1px solid #6a2a2a}
    .tdtl-profit-pos{color:#9cf9be !important;font-weight:700}
    .tdtl-profit-neg{color:#ffb4b4 !important;font-weight:700}
    .tdtl-table tbody tr:hover td{background:#141e2d !important}
    .tdtl-row-selected td{background:#243553 !important;box-shadow: inset 0 0 0 9999px rgba(36,53,83,0.18);outline:1px solid #4d7cff;}
    .tdtl-muted{color:#c7d3e0 !important;}
    .tdtl-empty{padding:16px 12px;color:#c7d3e0}
    .tdtl-footer{padding:8px 12px;font-size:11px;color:#c7d3e0;display:flex;gap:8px;justify-content:space-between;align-items:center;flex-wrap:wrap}
    .tdtl-credit{opacity:.85}
    .tdtl-close{margin-left:10px}
    .tdtl-launcher{position:fixed;top:84px;right:20px;z-index:999998}
    /* Buy cell layout */
    .tdtl-buycell{white-space:nowrap;}
    .tdtl-buywrap{display:inline-flex;align-items:center;gap:6px;}
    .tdtl-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:1px solid #4a5a76;border-radius:6px;background:#1f2a3a;cursor:pointer;font-size:11px;line-height:1}
    .tdtl-icon-btn:hover{background:#2a3a54}
    .tdtl-tag{display:inline-block;font-size:10px;padding:2px 6px;border:1px solid #4a5a76;border-radius:999px;opacity:0.9}
    .tdtl-inline-editor{display:inline-flex;align-items:center;gap:6px;}
    .tdtl-inline-editor input{width:90px;background:#0b0e13;color:#fff;border:1px solid #2b2f36;border-radius:6px;padding:4px 6px;font-size:12px;}
  `);

  // ------------------ Drag (with position save) --------------------
  function makeDraggable(handle, container, onStop) {
    let start = null, base = null, dragging = false;
    handle.addEventListener('mousedown', e => {
      dragging = true;
      start = { x: e.clientX, y: e.clientY };
      const r = container.getBoundingClientRect();
      base = { x: r.left, y: r.top };
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      container.style.left = `${base.x + dx}px`;
      container.style.top  = `${base.y + dy}px`;
      container.style.right = 'auto';
      container.style.bottom = 'auto';
      container.style.position = 'fixed';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      if (typeof onStop === 'function') onStop();
    });
  }

  // Persist/Restore helpers
  function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
  function savePanelPos(el){
    const r = el.getBoundingClientRect();
    GM_setValue(KEY_POS, { left: Math.round(r.left), top: Math.round(r.top) });
  }
  function restorePanelPos(el){
    const pos = GM_getValue(KEY_POS, null);
    if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = el.offsetWidth || 1180, h = el.offsetHeight || 400;
    const left = clamp(pos.left, 0, Math.max(0, vw - w));
    const top  = clamp(pos.top,  0, Math.max(0, vh - h));
    el.style.left = `${left}px`;
    el.style.top  = `${top}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.position = 'fixed';
  }

  // ------------------ HTTP --------------------
  async function fetchJSON(url, attempt = 0) {
    const r = await fetch(url, { cache: 'no-store' });

    // Network-level throttling
    if (r.status === 429 || r.status === 503) {
      const backoff = Math.min(2000 * (attempt + 1), 8000);
      await new Promise(res => setTimeout(res, backoff));
      return fetchJSON(url, attempt + 1);
    }

    let data = null; try { data = await r.json(); } catch {}

    // Torn API limit (code 5) can come back as a JSON error payload.
    if (data?.error?.code === 5) {
      const waitMs = 65000;
      await new Promise(res => setTimeout(res, waitMs));
      return fetchJSON(url, attempt + 1);
    }

    return { status: r.status, data };
  }
  const buildURL = (section, params) => `${API_BASE}/${section}/?${new URLSearchParams(params).toString()}`;

  // ------------------ Stock map (tickers) -----
  async function loadStockMap(key) {
    let map = GM_getValue(KEY_STOCK_MAP, null);
    if (map && typeof map === 'object') return map;
    const url = `${API_BASE}/torn/?selections=stocks&key=${key}`;
    const { data } = await fetchJSON(url);
    if (data?.stocks) {
      map = {};
      for (const [id, st] of Object.entries(data.stocks)) {
        map[id] = { acronym: st.acronym || st.name || id, name: st.name || st.acronym || id };
      }
      GM_setValue(KEY_STOCK_MAP, map);
      return map;
    }
    return {};
  }

  // ------------------ Logs fetch --------------
  async function fetchLogsWindow(key, from, to) {
    let pages = 0, cursorTo = to, all = [], lastStatus = '';
    while (pages < MAX_PAGES && all.length < MAX_LOGS) {
      const url = buildURL('user', { selections: 'log', from, to: cursorTo, key });
      const { status, data } = await fetchJSON(url);
      lastStatus = `HTTP ${status}`;
      if (!data) break;
      if (data.error) throw new Error(`API error ${data.error.code}: ${data.error.error}`);

      const chunk = data.log || {};
      const entries = Object.entries(chunk)
        .map(([id, obj]) => ({ id, ...obj }))
        .sort((a,b) => b.timestamp - a.timestamp);

      if (!entries.length) break;

      all = all.concat(entries);

      const oldest = entries[entries.length - 1].timestamp;
      if (oldest <= from) break;
      cursorTo = oldest - 1;
      pages++;
    }
    return { all, lastStatus };
  }

  // ------------------ Extractors --------------
  function extractFields(entry) {
    const d = entry?.data || {};
    const stockId = (typeof d.stock === 'number') ? d.stock : null;

    let shares = null, gross = null, price = null;
    if (typeof d.amount === 'number') shares = d.amount;
    if (typeof d.worth  === 'number') gross  = d.worth; // SELL (5511): Torn's NET
    if (d.price != null) {
      const p = (typeof d.price === 'number') ? d.price : parseFloat(d.price);
      if (!Number.isNaN(p) && Number.isFinite(p)) price = p;
    }
    if (price == null && shares != null && gross != null && shares > 0) price = gross / shares;
    if (gross == null && shares != null && price != null) gross = shares * price;

    return { stockId, shares, gross, price };
  }

  // ------------------ Ledger + Rows -----------
  function buildLedgerAndRows(entries, stockMap, manualMap) {
    const stockEntries = entries.filter(x => s(x.category || x.cat || '').toLowerCase().includes('stock'));
    const tradeEvents = stockEntries
      .map(x => {
        const isNumeric = typeof x.log === 'number' || /^\d+$/.test(s(x.log));
        const typeId = isNumeric ? Number(x.log) : null;
        if (typeId !== TYPE_BUY && typeId !== TYPE_SELL) return null;
        const f = extractFields(x);
        if (f.shares == null || f.gross == null) return null;
        const stockKey = f.stockId != null ? String(f.stockId) : '';
        const ticker = stockKey ? (stockMap?.[stockKey]?.acronym || stockMap?.[stockKey] || stockKey) : '—';

        return {
          id: x.id, ts: x.timestamp, when: asDate(x.timestamp),
          action: typeId === TYPE_BUY ? 'BUY' : 'SELL',
          ticker, shares: f.shares, price: f.price, gross: f.gross, raw: x, stockId: stockKey
        };
      })
      .filter(Boolean)
      .sort((a,b)=> a.ts - b.ts);

    const ledger = new Map(); // ticker -> { shares, cost }
    const rows = [];

    for (const ev of tradeEvents) {
      const key = ev.ticker;
      if (!ledger.has(key)) ledger.set(key, { shares: 0, cost: 0 });
      const lot = ledger.get(key);

      if (ev.action === 'BUY') {
        lot.shares += ev.shares;
        lot.cost   += ev.gross;
        rows.push({
          ...ev,
          fee: 0, net: null,
          buyPrice: ev.price, sellPrice: null,
          costTotal: ev.gross, profit: null, manual: false, editable: false
        });
      } else {
        const priceCents = Math.round((ev.price ?? 0) * 100);
        const shares = Number(ev.shares ?? 0);
        const grossExactCents = priceCents * shares;
        const grossExact = grossExactCents / 100;
        const fee = Math.ceil(grossExact * 0.001);
        const netExact = grossExact - fee;
        const net = Math.floor(netExact);
        const grossDisplay = net + fee;

        const currentAvg = (lot.shares > 0) ? (lot.cost / lot.shares) : null;

        let costTotal = null, profit = null, buyPriceOut = currentAvg, manualUsed = false, editable = false;

        if (currentAvg != null) {
          costTotal = currentAvg * ev.shares;
          profit = net - costTotal;
          lot.shares -= ev.shares;
          lot.cost   -= costTotal;
          if (lot.shares < 0) { lot.shares = 0; lot.cost = 0; }
        } else {
          const manual = manualMap && manualMap[ev.id];
          if (manual && typeof manual.buyPrice === 'number' && isFinite(manual.buyPrice) && manual.buyPrice > 0) {
            buyPriceOut = manual.buyPrice;
            costTotal   = manual.buyPrice * ev.shares;
            profit      = net - costTotal;
            manualUsed  = true;
          } else {
            editable = true;
          }
        }

        rows.push({
          ...ev, gross: grossDisplay, fee, net,
          buyPrice: buyPriceOut, sellPrice: ev.price,
          costTotal, profit, manual: manualUsed, editable
        });
      }
    }

    return rows.sort((a,b)=> b.ts - a.ts);
  }

  // ------------------ Render: Trades ----------
  function renderSummary(container, rows) {
    const sells = rows.filter(r => r.action === 'SELL');
    const totalBuy  = sells.reduce((a,r)=> a + (r.costTotal || 0), 0);
    const totalSell = sells.reduce((a,r)=> a + (r.net       || 0), 0);
    const totalFee  = sells.reduce((a,r)=> a + (r.fee       || 0), 0);
    const totalProf = sells.reduce((a,r)=> a + (r.profit    || 0), 0);

    container.innerHTML = `
      <div class="tdtl-summary">
        <div class="card"><div class="tdtl-muted">Total Buy</div><div style="font-weight:700">${money0(totalBuy)}</div></div>
        <div class="card"><div class="tdtl-muted">Total Sell</div><div style="font-weight:700">${money0(totalSell)}</div></div>
        <div class="card"><div class="tdtl-muted">Profit</div><div style="font-weight:700">${money0(totalProf)}</div></div>
        <div class="card"><div class="tdtl-muted">Fees Paid</div><div style="font-weight:700">${money0(totalFee)}</div></div>
      </div>
    `;
  }

  function attachRowSelection(tbody){
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      const multi = e.ctrlKey || e.metaKey;
      if (!tr) {
        tbody.querySelectorAll('.tdtl-row-selected').forEach(r => r.classList.remove('tdtl-row-selected'));
        return;
      }
      if (multi) tr.classList.toggle('tdtl-row-selected');
      else {
        tbody.querySelectorAll('.tdtl-row-selected').forEach(r => { if (r !== tr) r.classList.remove('tdtl-row-selected'); });
        tr.classList.add('tdtl-row-selected');
      }
    });
  }

  function renderTable(body, statusEl, rows, rawCount, stockCount, rangeDays, windowLabel) {
    if (!rows.length) {
      body.innerHTML = `<div class="tdtl-empty">No BUY/SELL logs for ${windowLabel ? windowLabel : ('last ' + rangeDays + ' day(s)')}. (Pulled ${rawCount} → ${stockCount} stock logs)</div>`;
      statusEl.textContent = `Done.`;
      return;
    }

    const summaryEl = document.createElement('div');
    summaryEl.className = 'tdtl-summary';
    body.innerHTML = '';
    body.appendChild(summaryEl);
    renderSummary(summaryEl, rows);

    const tbl = document.createElement('table');
    tbl.className = 'tdtl-table';
    tbl.innerHTML = `
      <thead><tr>
        <th>Action</th><th>When</th><th>Stock</th><th>Buy Price</th><th>Sell Price</th>
        <th>Shares</th><th>Gross (Sell)</th><th>Fee (0.10%)</th><th>Total Buy</th><th>Total Sell</th><th>Profit</th>
      </tr></thead>
      <tbody></tbody>
    `;
    body.appendChild(tbl);
    const tbody = tbl.querySelector('tbody');

    for (const r of rows) {
      const profitClass = (r.profit==null) ? '' : (r.profit>0 ? 'tdtl-profit-pos' : 'tdtl-profit-neg');
      const tr = document.createElement('tr');
      tr.dataset.rowId = r.id;

      const buyPriceText = (r.buyPrice != null ? '$' + price2(r.buyPrice) : '—');
      let buyCellHTML;
      if (r.editable) {
        buyCellHTML = `<span class="tdtl-buywrap"><span class="tdtl-bptext">${buyPriceText}</span>
          <button class="tdtl-icon-btn tdtl-manual-btn" title="Set buy price">✎</button></span>`;
      } else if (r.manual) {
        buyCellHTML = `<span class="tdtl-buywrap"><span class="tdtl-bptext">${buyPriceText}</span>
          <span class="tdtl-tag">manual</span></span>`;
      } else {
        buyCellHTML = `<span class="tdtl-buywrap"><span class="tdtl-bptext">${buyPriceText}</span></span>`;
      }

      tr.innerHTML = `
        <td><span class="tdtl-pill ${r.action==='BUY'?'tdtl-buy':'tdtl-sell'}">${r.action}</span></td>
        <td>${r.when}</td>
        <td>${r.ticker ?? '—'}</td>
        <td class="tdtl-buycell">${buyCellHTML}</td>
        <td>${r.sellPrice != null ? '$' + price2(r.sellPrice) : '—'}</td>
        <td>${r.shares    != null ? intFmt(r.shares) : '—'}</td>
        <td>${r.action === 'BUY' ? '—' : (r.gross != null ? money0(r.gross) : '—')}</td>
        <td>${r.fee       != null ? money0(r.fee) : '—'}</td>
        <td>${r.costTotal != null ? money0(r.costTotal) : '—'}</td>
        <td>${r.action === 'BUY' ? 'N/A' : (r.net != null ? money0(r.net) : '—')}</td>
        <td class="${profitClass}">${r.profit!=null ? (r.profit>0?'+':'') + money0(r.profit) : '—'}</td>
      `;
      tbody.appendChild(tr);
    }

    // Enable clickable selection
    attachRowSelection(tbody);

    // Inline manual editor
    tbody.addEventListener('click', (e) => {
      const btn = e.target.closest('.tdtl-manual-btn');
      if (!btn) return;
      const cell = btn.closest('.tdtl-buycell');
      const row = btn.closest('tr');
      if (!cell || !row) return;

      const currentTextEl = cell.querySelector('.tdtl-bptext');
      const currentVal = Number((currentTextEl?.textContent || '').replace(/[^0-9.]/g,'')) || '';

      const editor = document.createElement('span');
      editor.className = 'tdtl-inline-editor';
      editor.innerHTML = `<input type="number" step="0.01" min="0" value="${currentVal}">
                          <button class="tdtl-icon-btn tdtl-ok" title="Save">✓</button>
                          <button class="tdtl-icon-btn tdtl-cancel" title="Cancel">×</button>`;

      const wrap = cell.querySelector('.tdtl-buywrap');
      wrap.replaceWith(editor);
      const input = editor.querySelector('input');
      input.focus(); input.select();

      const commit = () => {
        const v = Number(input.value);
        if (!isFinite(v) || v <= 0) {
          notify('Invalid buy price.');
          cancel();
          return;
        }
        const rowId = row.dataset.rowId;
        setManualBuy(rowId, v);
        document.dispatchEvent(new CustomEvent('tdtl-refresh-now'));
      };
      const cancel = () => {
        document.dispatchEvent(new CustomEvent('tdtl-refresh-now'));
      };

      editor.querySelector('.tdtl-ok').addEventListener('click', commit);
      editor.querySelector('.tdtl-cancel').addEventListener('click', cancel);
      input.addEventListener('keydown', (ev)=>{
        if (ev.key === 'Enter') commit();
        else if (ev.key === 'Escape') cancel();
      });

      // Right-click on buy cell clears manual for that row
      row.addEventListener('contextmenu', (ev)=>{
        if (!ev.target.closest('.tdtl-buycell')) return;
        ev.preventDefault();
        const rowId = row.dataset.rowId;
        setManualBuy(rowId, null);
        notify('Manual buy price cleared for this row.');
        document.dispatchEvent(new CustomEvent('tdtl-refresh-now'));
      }, { once: true });
    });

    const counts = rows.reduce((acc,r)=>{acc[r.action]=(acc[r.action]||0)+1; return acc;},{});
    statusEl.innerHTML = `Done. Rows: ${rows.length} (BUY: ${counts.BUY||0} | SELL: ${counts.SELL||0}). <span class="tdtl-credit">Made by Eaglewing [571041]</span>`;
  }

  // ------------------ UI ----------------------
  function createPanel() {
    const wrap = document.createElement('div');
    wrap.className = 'tdtl-wrap';
    wrap.innerHTML = `
      <div class="tdtl-header">
        <div>${TITLE}</div>
        <div><button class="tdtl-btn tdtl-close" title="Close">✕</button></div>
      </div>

      <div class="tdtl-controls">
        <button data-range="7"  class="tdtl-btn">7D</button>
        <button data-range="14" class="tdtl-btn">14D</button>
        <button data-range="30" class="tdtl-btn">30D</button>
        <span class="tdtl-muted" style="margin-left:6px">From</span>
        <input id="tdtl-from" class="tdtl-date" type="date">
        <span class="tdtl-muted">To</span>
        <input id="tdtl-to" class="tdtl-date" type="date">
        <button id="tdtl-clear-dates" class="tdtl-btn" title="Clear custom dates and use 7D/14D/30D buttons">Clear Dates</button>
        <button id="tdtl-pull" class="tdtl-btn">Pull Now</button>
        <button id="tdtl-test" class="tdtl-btn">Test Key</button>
        <input id="tdtl-key" class="tdtl-input" type="password" placeholder="Full Access API key (stored locally)">
        <button id="tdtl-clear-manual" class="tdtl-btn" title="Clear all manually-set BUY prices for SELL rows">Clear Manual</button>
      </div>

      <div class="tdtl-diagnostics">
        <div id="tdtl-progress" class="tdtl-progress"><div class="tdtl-progress-bar"></div></div>
      </div>

      <div class="tdtl-body"><div class="tdtl-empty">Choose 7D / 14D / 30D, or set a custom From/To date range, then click <b>Pull Now</b>.</div></div>
      <div class="tdtl-footer">
        <div class="tdtl-muted" id="tdtl-status">Idle. <span class="tdtl-credit">Made by Eaglewing [571041]</span></div>
      </div>
    `;
    document.body.appendChild(wrap);

    restorePanelPos(wrap);

    const savedKey = GM_getValue(KEY_API, '');
    if (savedKey) wrap.querySelector('#tdtl-key').value = savedKey;

    const lastRange = GM_getValue(KEY_LAST_RANGE, '7');
    activateRangeButton(wrap, lastRange);

    const fromEl = wrap.querySelector('#tdtl-from');
    const toEl   = wrap.querySelector('#tdtl-to');
    const clearDatesBtn = wrap.querySelector('#tdtl-clear-dates');

    // Restore custom dates (if any)
    if (fromEl) fromEl.value = GM_getValue(KEY_CUSTOM_FROM, '') || '';
    if (toEl)   toEl.value   = GM_getValue(KEY_CUSTOM_TO, '') || '';

    if (fromEl) fromEl.addEventListener('change', () => GM_setValue(KEY_CUSTOM_FROM, fromEl.value || ''));
    if (toEl)   toEl.addEventListener('change', () => GM_setValue(KEY_CUSTOM_TO, toEl.value || ''));

    if (clearDatesBtn) clearDatesBtn.addEventListener('click', () => {
      if (fromEl) fromEl.value = '';
      if (toEl) toEl.value = '';
      GM_setValue(KEY_CUSTOM_FROM, '');
      GM_setValue(KEY_CUSTOM_TO, '');
      notify('Custom dates cleared (using 7D/14D/30D).');
    });

    const progressEl = wrap.querySelector('#tdtl-progress');
    const body = wrap.querySelector('.tdtl-body');
    const statusEl = wrap.querySelector('#tdtl-status');

    const setLoading = (on) => { if (on) progressEl.classList.add('active'); else progressEl.classList.remove('active'); };

    wrap.querySelector('.tdtl-close').addEventListener('click', () => wrap.remove());
    wrap.querySelectorAll('[data-range]').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = btn.getAttribute('data-range');
        GM_setValue(KEY_LAST_RANGE, r);
        activateRangeButton(wrap, r);

        // Switching to a preset range clears any custom date selection
        const fromEl = wrap.querySelector('#tdtl-from');
        const toEl   = wrap.querySelector('#tdtl-to');
        if (fromEl) fromEl.value = '';
        if (toEl) toEl.value = '';
        GM_setValue(KEY_CUSTOM_FROM, '');
        GM_setValue(KEY_CUSTOM_TO, '');
      });
    });

    const keyInput = wrap.querySelector('#tdtl-key');
    keyInput.addEventListener('change', (e) => GM_setValue(KEY_API, e.target.value.trim()));

    const pullBtn = wrap.querySelector('#tdtl-pull');
    const testBtn = wrap.querySelector('#tdtl-test');
    const clearBtn = wrap.querySelector('#tdtl-clear-manual');
    clearBtn.addEventListener('click', () => {
      if (confirm('Clear ALL manually-set BUY prices for SELL rows?')) {
        clearAllManual();
        notify('Manual BUY prices cleared.');
        document.dispatchEvent(new CustomEvent('tdtl-refresh-now'));
      }
    });

    let lastFetched = null;
    async function doPull() {
      const rangeDays = parseInt(GM_getValue(KEY_LAST_RANGE, '7'), 10);
      const key = (keyInput.value || '').trim();
      if (!key) return notify('Please paste your Full Access API key first.');
      GM_setValue(KEY_API, key);

      // Determine the requested time window:
      // - If BOTH custom dates are set, use them (inclusive of the full 'To' day).
      // - Otherwise, use the selected preset (7D/14D/30D).
      const fromStr = (fromEl && fromEl.value) ? fromEl.value : '';
      const toStr   = (toEl && toEl.value) ? toEl.value : '';

      const isPresetRange = !(fromStr && toStr); // presets (7D/14D/30D) always fetch live

      let from, to, label;
      if (fromStr && toStr) {
        from = dateStrToUnixStart(fromStr);
        to   = dateStrToUnixEnd(toStr);
        if (!isFinite(from) || !isFinite(to) || from > to) {
          notify('Invalid custom date range. Please check From/To.');
          return;
        }
        label = `${fromStr} → ${toStr}`;
      } else {
        to = unixNow();
        from = daysAgoUnix(rangeDays);
        label = `last ${rangeDays} day(s)`;
      }

      body.innerHTML = `<div class="tdtl-empty">Pulling logs for ${label}…</div>`;
      statusEl.textContent = `Preparing ${label}…`;
      setLoading(true);

      try {
        const stockMap = await loadStockMap(key);

        // Fetch strategy:
        // - Preset ranges (7D/14D/30D): ALWAYS fetch live data from the API (then merge into cache)
        // - Custom date range: cache-aware (fetch ONLY missing parts)
        if (isPresetRange) {
          statusEl.textContent = `Fetching live logs for ${label}…`;
          const { all } = await fetchLogsWindow(key, from, to, (p) => {
            if (!p) return;
            statusEl.textContent = `Fetching live logs… (pages: ${p.pages + 1}, logs: ${p.count.toLocaleString()})`;
          });

          // Merge into cache (dedupe by log id)
          const cache = getLogCache();
          for (const entry of all) {
            if (entry && entry.id && !cache[entry.id]) cache[entry.id] = entry;
          }
          setLogCache(cache);
          addCoverage(from, to);
        } else {
          // Cache-aware pull: fetch ONLY missing parts of the requested time window
          await ensureRangeCached(key, from, to, statusEl);
        }

        // Display window logs (what the user asked for)
        const displayLogs = getCachedLogsInRange(from, to);

        // OPTION 1 (ledger context): include prior BUY/SELL events from before the
        // range start so SELLs inside the range can resolve buy price / average cost.
        const contextLogs = getCachedLogsBefore(from);
        const ledgerInput = contextLogs.concat(displayLogs);

        statusEl.textContent = `Using ${displayLogs.length} cached log entries (+${contextLogs.length} prior for ledger). Building ledger…`;

        const stockEntries = displayLogs.filter(x => s(x.category || x.cat || '').toLowerCase().includes('stock'));
        const manualMap = getManualMap();

        // Build ledger from context + display, then only show rows within the display window
        const rowsAll = buildLedgerAndRows(ledgerInput, stockMap, manualMap);
        const rows = rowsAll.filter(r => typeof r.ts === 'number' && r.ts >= from && r.ts <= to);

        lastFetched = { rows, allLogs: displayLogs, stockEntriesCount: stockEntries.length, rangeDays, fromTs: from, toTs: to, windowLabel: label };
        renderTable(body, statusEl, rows, displayLogs.length, stockEntries.length, rangeDays, label);
      } catch (e) {
        body.innerHTML = `<div class="tdtl-empty">Error: ${(e && e.message) || e}</div>`;
        statusEl.textContent = 'Error.';
      } finally {
        setLoading(false);
      }
    }

    function softRefresh(){
      if (!lastFetched) return doPull();
      const { rangeDays, fromTs, toTs } = lastFetched;
      const key = (keyInput.value || '').trim();
      const manualMap = getManualMap();
      (async () => {
        setLoading(true);
        try {
          const stockMap = await loadStockMap(key);

          // Rebuild from cached logs for the same window (no new API calls)
          const from = (typeof fromTs === 'number' && isFinite(fromTs)) ? fromTs : daysAgoUnix(rangeDays);
          const to   = (typeof toTs === 'number' && isFinite(toTs)) ? toTs : unixNow();

          const displayLogs = getCachedLogsInRange(from, to);
          const contextLogs = getCachedLogsBefore(from);
          const ledgerInput = contextLogs.concat(displayLogs);
          const stockEntriesCount = displayLogs.filter(x => s(x.category || x.cat || '').toLowerCase().includes('stock')).length;

          const rowsAll = buildLedgerAndRows(ledgerInput, stockMap, manualMap);
          const rows = rowsAll.filter(r => typeof r.ts === 'number' && r.ts >= from && r.ts <= to);

          lastFetched.rows = rows;
          lastFetched.allLogs = displayLogs;
          lastFetched.stockEntriesCount = stockEntriesCount;
          renderTable(body, statusEl, rows, displayLogs.length, stockEntriesCount, rangeDays, lastFetched.windowLabel);
        } catch(e){
          notify('Soft refresh failed: ' + (e && e.message || e));
        } finally {
          setLoading(false);
        }
      })();
    }

    document.addEventListener('tdtl-refresh-now', softRefresh);

    pullBtn.addEventListener('click', doPull);

    testBtn.addEventListener('click', async () => {
      const key = (keyInput.value || '').trim();
      if (!key) return notify('Please paste your Full Access API key first.');
      setLoading(true);
      try {
        const url = buildURL('user', { selections: 'basic', key });
        const { status, data } = await fetchJSON(url);
        let msg;
        if (data?.error) msg = `API error ${data.error.code}: ${data.error.error}`;
        else if (status !== 200 || !data?.player_id) msg = `Unexpected response (HTTP ${status}).`;
        else msg = `OK (player_id ${data.player_id})`;
        notify(`Test key: ${msg}`);
      } catch (e) {
        notify(`Test key failed: ${(e && e.message) || e}`);
      } finally {
        setLoading(false);
      }
    });

    makeDraggable(wrap.querySelector('.tdtl-header'), wrap, () => savePanelPos(wrap));
    window.addEventListener('beforeunload', () => savePanelPos(wrap));
  }

  // --------------- Helpers --------------------
  function activateRangeButton(root, r) {
    root.querySelectorAll('[data-range]').forEach(b => b.classList.remove('active'));
    const active = root.querySelector(`[data-range="${r}"]`);
    if (active) active.classList.add('active');
  }

  function addLauncher() {
    const existing = document.querySelector('.tdtl-launcher');
    if (existing) return;
    const btn = document.createElement('button');
    btn.textContent = 'Day Trader Logbook';
    btn.className = 'tdtl-btn tdtl-launcher';
    btn.addEventListener('click', () => { document.querySelector('.tdtl-wrap')?.remove(); createPanel(); });
    document.body.appendChild(btn);
  }

  function onStocksPage() { return location.pathname === '/page.php' && new URLSearchParams(location.search).get('sid') === 'stocks'; }

  GM_registerMenuCommand('Set Full Access API Key', () => {
    const current = GM_getValue(KEY_API, '');
    const next = prompt('Paste your Full Access API key:', current || '');
    if (next !== null) GM_setValue(KEY_API, next.trim());
  });
  GM_registerMenuCommand('Clear ALL manual BUY prices', () => {
    if (confirm('Clear ALL manually-set BUY prices for SELL rows?')) {
      clearAllManual();
      notify('Manual BUY prices cleared.');
      document.dispatchEvent(new CustomEvent('tdtl-refresh-now'));
    }
  });

  GM_registerMenuCommand('Clear cached log history', () => {
    const msg =
      'Clear ALL cached trade logs?\n\n' +
      'This cannot be undone.\n\n' +
      '• Your API key will NOT be removed\n' +
      '• Manual BUY overrides will NOT be removed\n\n' +
      'You will need to re-pull date ranges again.';
    if (!confirm(msg)) return;
    clearLogCacheWithCoverage();
    notify('Cached log history cleared.');
    document.dispatchEvent(new CustomEvent('tdtl-refresh-now'));
  });


  if (onStocksPage()) { createPanel(); addLauncher(); }
})();
