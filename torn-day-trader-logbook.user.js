// ==UserScript==
// @name         Torn Stock Ledger
// @namespace    https://github.com/Eaglewing91
// @version      1.0.0
// @author       Eaglewing [571041]
// @homepageURL  https://github.com/Eaglewing91/torn-day-trader-logbook
// @updateURL   https://raw.githubusercontent.com/Eaglewing91/torn-day-trader-logbook/main/torn-stock-ledger.user.js
// @downloadURL https://raw.githubusercontent.com/Eaglewing91/torn-day-trader-logbook/main/torn-stock-ledger.user.js
// @description  Newly developed, fully working release of the original Torn Day Trader Logbook (Experimental), now named Torn Stock Ledger. View stock trades, costs, fees and profit for 7/14/30 days, custom dates, or full account history. Full History may take a minute or two to obtain all available data. Requires a Full Access API key.
// @match        https://www.torn.com/page.php*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @license      MIT
// ==/UserScript==

// Standalone page implementation. On Stocks, the header contains a link; on
// the ledger URL, the stock application is replaced with the ledger page.
// Balanced-row build: compact trade text increased by about 15%.
(function () {
  'use strict';

  const STOCKS_URL = '/page.php?sid=stocks';
  const LEDGER_URL = STOCKS_URL + '&ewStockLedger=1';
  const API = 'https://api.torn.com';
  const DAY = 86400;
  const PAGE_LIMIT = 100;
  const WINDOW = 90 * DAY;
  const STOCK_BUY = 5510;
  const STOCK_SELL = 5511;

  // Retaining these keys keeps the full history already imported by the
  // separate ledger test available to this release.
  const KEY = Object.freeze({
    api: 'tdtl_history_test_api_key_v111exp',
    range: 'tdtl_history_test_last_range_v111exp',
    from: 'tdtl_history_test_custom_from_v111exp',
    to: 'tdtl_history_test_custom_to_v111exp',
    stockMap: 'tdtl_history_test_stock_map_v111exp',
    manual: 'tdtl_history_test_manual_buys_v111exp',
    ticker: 'tdtl_history_test_active_ticker_v111exp',
    logs: 'tdtl_history_test_log_cache_v111exp',
    coverage: 'tdtl_history_test_stock_cov_v1110test',
    signup: 'torn_stock_ledger_signup_v1'
  });

  const now = () => Math.floor(Date.now() / 1000);
  const readObject = (key) => {
    const value = GM_getValue(key, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  };
  const number = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const clean = value.replace(/[^\d.-]/g, '');
    if (!clean || clean === '-' || clean === '.') return null;
    const parsed = Number(clean);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const currency = (value, decimals = 0) => value == null ? '—' :
    '$' + Number(value).toLocaleString(undefined, {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals
    });
  const quantity = (value) => Number(value).toLocaleString();
  const when = (timestamp) => new Date(timestamp * 1000).toLocaleString();
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function dateBoundary(text, end = false) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return NaN;
    const date = new Date(text + (end ? 'T23:59:59' : 'T00:00:00'));
    if (date.getFullYear() !== Number(text.slice(0, 4)) ||
        date.getMonth() + 1 !== Number(text.slice(5, 7)) ||
        date.getDate() !== Number(text.slice(8, 10))) return NaN;
    return Math.floor(date.getTime() / 1000);
  }

  function normalizeCoverage(intervals) {
    const sorted = (Array.isArray(intervals) ? intervals : [])
      .map(pair => [Number(pair?.[0]), Number(pair?.[1])])
      .filter(([start, end]) => Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end)
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const interval of sorted) {
      const previous = merged[merged.length - 1];
      if (previous && interval[0] <= previous[1] + 1) {
        previous[1] = Math.max(previous[1], interval[1]);
      } else {
        merged.push([...interval]);
      }
    }
    return merged;
  }

  function coverage() {
    return normalizeCoverage(GM_getValue(KEY.coverage, []));
  }

  function markCovered(start, end) {
    GM_setValue(KEY.coverage, normalizeCoverage([...coverage(), [start, end]]));
  }

  function missingIntervals(start, end) {
    let cursor = start;
    const missing = [];
    for (const [a, b] of coverage()) {
      if (b < cursor) continue;
      if (a > end) break;
      if (a > cursor) missing.push([cursor, Math.min(a - 1, end)]);
      cursor = Math.max(cursor, b + 1);
      if (cursor > end) break;
    }
    if (cursor <= end) missing.push([cursor, end]);
    return missing;
  }

  function coveredSeconds(start, end) {
    return coverage().reduce((sum, [a, b]) =>
      sum + Math.max(0, Math.min(end, b) - Math.max(start, a) + 1), 0);
  }

  function windowsFor(intervals) {
    const windows = [];
    for (const [start, end] of [...intervals].reverse()) {
      for (let last = end; last >= start;) {
        const first = Math.max(start, last - WINDOW + 1);
        windows.push([first, last]);
        last = first - 1;
      }
    }
    return windows;
  }

  // Torn's stock log endpoint returns at most 100 records. Splitting a full
  // date window ensures every record is fetched without following a repeated
  // pagination cursor. Coverage is saved only after a complete window.
  const attempts = [];
  async function apiJSON(path, params, report = () => {}) {
    const url = new URL(path, API);
    url.search = new URLSearchParams(params).toString();
    for (let retry = 0; retry < 4; retry++) {
      const current = Date.now();
      while (attempts.length && current - attempts[0] >= 60000) attempts.shift();
      if (attempts.length >= 45) {
        const delay = 61000 - (current - attempts[0]);
        report('Waiting ' + Math.ceil(delay / 1000) + 's for the API request limit…');
        await wait(delay);
        while (attempts.length && Date.now() - attempts[0] >= 60000) attempts.shift();
      }
      attempts.push(Date.now());
      let response;
      let data;
      try {
        response = await fetch(url.href, { cache: 'no-store' });
        data = await response.json();
      } catch (error) {
        if (retry === 3) throw error;
        report('Connection interrupted; retrying…');
        await wait(2000 * (retry + 1));
        continue;
      }
      if (response.status === 429 || response.status === 503 || data?.error?.code === 5) {
        if (retry === 3) throw new Error('Torn is still rate limiting requests. Try again to continue.');
        report('Torn is rate limiting requests; waiting 65s…');
        await wait(65000);
        continue;
      }
      if (data?.error) throw new Error('API error ' + data.error.code + ': ' + data.error.error);
      if (!response.ok || !data) throw new Error('Unexpected API response (HTTP ' + response.status + ').');
      return data;
    }
    throw new Error('Could not reach the Torn API.');
  }

  async function stockMapFor(key, report) {
    const saved = readObject(KEY.stockMap);
    if (Object.keys(saved).length) return saved;
    try {
      const data = await apiJSON('/torn/', { selections: 'stocks', key }, report);
      const map = {};
      for (const [id, stock] of Object.entries(data.stocks || {})) {
        map[id] = { acronym: stock.acronym || stock.name || id, name: stock.name || id };
      }
      if (Object.keys(map).length) GM_setValue(KEY.stockMap, map);
      return map;
    } catch {
      return {};
    }
  }

  async function accountSignup(key, report) {
    const saved = Number(GM_getValue(KEY.signup, 0));
    if (Number.isSafeInteger(saved) && saved > 0 && saved <= now()) return saved;
    const data = await apiJSON('/v2/user/profile', { key }, report);
    const signup = Number(data.profile?.signed_up);
    if (!Number.isSafeInteger(signup) || signup <= 0 || signup > now()) {
      throw new Error('Could not read your account creation date.');
    }
    GM_setValue(KEY.signup, signup);
    return signup;
  }

  function normalizeTrade(raw) {
    const id = raw?.id == null ? '' : String(raw.id);
    const timestamp = Number(raw?.timestamp);
    const type = Number(raw?.details?.id);
    if (!id || !Number.isSafeInteger(timestamp) || (type !== STOCK_BUY && type !== STOCK_SELL)) {
      throw new Error('The API returned an unexpected stock trade.');
    }
    return {
      id, timestamp, log: type, category: raw.details?.category || 'Stock',
      data: raw.data || {}, params: raw.params || {}
    };
  }

  function mergeTrades(entries) {
    const cache = readObject(KEY.logs);
    let added = 0;
    for (const entry of entries) {
      if (!cache[entry.id]) added++;
      cache[entry.id] = entry;
    }
    GM_setValue(KEY.logs, cache);
    return added;
  }

  async function importRange(key, start, end, fresh, report) {
    const intervals = fresh ? [[start, end]] : missingIntervals(start, end);
    const queue = windowsFor(intervals);
    let requests = 0;
    let added = 0;
    while (queue.length) {
      const [first, last] = queue[0];
      report({ requests, added, pending: queue.length,
        message: 'Checking ' + new Date(first * 1000).toLocaleDateString() +
          ' – ' + new Date(last * 1000).toLocaleDateString() + '…' });
      const data = await apiJSON('/v2/user/log', {
        log: STOCK_BUY + ',' + STOCK_SELL, limit: PAGE_LIMIT,
        from: first, to: last, key
      }, message => report({ requests, added, pending: queue.length, message }));
      if (!Array.isArray(data.log) || !data._metadata?.links ||
          !('next' in data._metadata.links)) {
        throw new Error('The stock log API response was incomplete. Progress was saved.');
      }
      requests++;
      const entries = data.log.map(normalizeTrade);
      if (entries.some(entry => entry.timestamp < first || entry.timestamp > last)) {
        throw new Error('The API returned trades outside the requested dates. Progress was saved.');
      }
      added += mergeTrades(entries);
      if (entries.length >= PAGE_LIMIT || data._metadata.links.next) {
        if (first === last) {
          throw new Error('More than 100 trades occurred in one second. Progress was saved.');
        }
        const middle = first + Math.floor((last - first) / 2);
        queue.splice(0, 1, [middle + 1, last], [first, middle]);
        continue;
      }
      markCovered(first, last);
      queue.shift();
      report({ requests, added, pending: queue.length,
        message: requests + ' requests · ' + added + ' new trades · ' + queue.length + ' windows left' });
    }
    return { requests, added };
  }

  function ledgerRows(logs, stockMap, manual) {
    const events = logs
      .filter(log => Number(log?.log) === STOCK_BUY || Number(log?.log) === STOCK_SELL)
      .map(log => {
        const shares = number(log.data?.amount);
        const worth = number(log.data?.worth);
        let price = number(log.data?.price);
        if (price == null && shares > 0 && worth != null) price = worth / shares;
        const spent = worth ?? (shares != null && price != null ? shares * price : null);
        if (!Number.isSafeInteger(Number(log.timestamp)) || !shares || shares <= 0 || spent == null) return null;
        const stockId = String(log.data?.stock ?? '');
        const stock = stockMap[stockId];
        const ticker = typeof stock === 'string' ? stock : stock?.acronym || stockId || '—';
        return {
          id: String(log.id), ts: Number(log.timestamp), ticker,
          action: Number(log.log) === STOCK_BUY ? 'BUY' : 'SELL',
          shares, price, spent
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id, undefined, { numeric: true }));

    const holdings = new Map();
    const rows = [];
    for (const event of events) {
      const lot = holdings.get(event.ticker) || { shares: 0, cost: 0 };
      holdings.set(event.ticker, lot);
      if (event.action === 'BUY') {
        lot.shares += event.shares;
        lot.cost += event.spent;
        rows.push({
          ...event, buyPrice: event.price, sellPrice: null, gross: null,
          fee: 0, cost: event.spent, net: null, profit: null, manual: false, editable: false
        });
        continue;
      }
      const gross = Math.round((event.price ?? 0) * 100) * event.shares / 100;
      const fee = Math.ceil(gross * 0.001);
      const net = Math.floor(gross - fee);
      let buyPrice = lot.shares > 0 ? lot.cost / lot.shares : null;
      let manualUsed = false;
      if (buyPrice == null) {
        const override = Number(manual[event.id]?.buyPrice);
        if (Number.isFinite(override) && override > 0) {
          buyPrice = override;
          manualUsed = true;
        }
      } else {
        const costRemoved = buyPrice * event.shares;
        lot.shares -= event.shares;
        lot.cost -= costRemoved;
        if (lot.shares <= 0) { lot.shares = 0; lot.cost = 0; }
      }
      const cost = buyPrice == null ? null : buyPrice * event.shares;
      rows.push({
        ...event, buyPrice, sellPrice: event.price, gross: net + fee,
        fee, cost, net, profit: cost == null ? null : net - cost,
        manual: manualUsed, editable: buyPrice == null
      });
    }
    return rows.reverse();
  }

  GM_addStyle(`
    #tsl-link{display:inline-block;margin-left:12px;padding-left:12px;border-left:1px solid #77343c;
      color:#ed5863!important;font-size:12px;font-weight:700;text-decoration:none;white-space:nowrap}
    #tsl-link:hover{text-decoration:underline}
    #tsl-page{--bg:#0e0b0d;--surface:#191316;--raised:#25191d;--line:#4b2b32;
      --text:#f6eef0;--muted:#b9a6aa;--red:#e44756;--green:#93dcbe;
      display:block;box-sizing:border-box;width:100%;min-width:0;min-height:600px;margin:12px 0 24px;
      background:var(--bg);color:var(--text);border:1px solid var(--line);
      border-radius:11px;font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
      box-shadow:0 14px 36px #0004;overflow:hidden}
    #tsl-page *{box-sizing:border-box}
    #tsl-page button,#tsl-page input,#tsl-page select{font:inherit}
    #tsl-page button{cursor:pointer}
    #tsl-page .header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:20px;
      padding:20px 24px;background:linear-gradient(110deg,#34191e,#1c1316 57%,#110d0f);
      border-bottom:1px solid #72353f}
    #tsl-page .heading{display:flex;align-items:center;gap:13px;min-width:0}
    #tsl-page .mark{display:grid;place-items:center;width:35px;height:35px;border-radius:9px;
      background:var(--red);color:#1a080c;font-size:20px;font-weight:900}
    #tsl-page h2{margin:0;color:var(--text);font-size:18px;line-height:1.2}
    #tsl-page .subtitle{color:#d7a5ad;font-size:11px;letter-spacing:.09em;text-transform:uppercase}
    #tsl-page .back{color:#ff8790!important;white-space:nowrap;text-decoration:none;font-weight:700}
    #tsl-page .back:hover{text-decoration:underline}
    #tsl-page .toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:9px;padding:12px 20px;
      background:var(--surface);border-bottom:1px solid var(--line)}
    #tsl-page .toolbar.secondary{background:#140f11}
    #tsl-page .toolbar-group{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0;max-width:100%}
    #tsl-page .spacer{flex:1 1 12px}
    #tsl-page label{color:var(--muted);font-size:11px;font-weight:700}
    #tsl-page .button{min-height:33px;padding:6px 11px;border:1px solid #66414a!important;
      border-radius:7px;background:#291d20!important;color:var(--text)!important;font-weight:700}
    #tsl-page .button:hover{background:#3c272d!important;border-color:#ba6270!important}
    #tsl-page .button.active,#tsl-page .button.primary{background:#bb3342!important;
      border-color:#ef6472!important;color:#fff!important}
    #tsl-page .button:disabled{opacity:.55;cursor:default}
    #tsl-page input,#tsl-page select{height:33px;padding:5px 9px;border-radius:7px;
      border:1px solid #64414a!important;background:#100c0e!important;color:var(--text)!important;
      color-scheme:dark}
    #tsl-page input[type=date]{width:137px;max-width:100%}
    #tsl-page #tsl-key{width:190px;max-width:100%}
    #tsl-page .progress{height:5px;background:#281a1e;overflow:hidden}
    #tsl-page .progress>span{display:block;width:0;height:100%;background:var(--red);
      transition:width .15s ease}
    #tsl-page .progress.running:not(.measured)>span{width:32%;
      animation:tsl-loading 1.3s linear infinite}
    @keyframes tsl-loading{from{transform:translateX(-110%)}to{transform:translateX(420%)}}
    #tsl-page .filterbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:10px 20px;
      border-bottom:1px solid var(--line);background:#201519}
    #tsl-page #tsl-count{color:var(--muted);font-size:11px}
    #tsl-page .tabs{display:flex;flex-wrap:wrap;gap:7px;padding:14px 20px 3px}
    #tsl-page .tab{padding:6px 10px;border-radius:7px;border:1px solid #624049!important;
      background:#21171a!important;color:#eadadd!important;font-weight:700}
    #tsl-page .tab.active{border-color:#f47681!important;background:#a92d3b!important;color:#fff!important}
    #tsl-page .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));
      gap:10px;padding:13px 20px 18px}
    #tsl-page .card{min-width:0;padding:13px;border-radius:9px;border:1px solid var(--line);
      background:var(--surface)}
    #tsl-page .card.profit{background:#28161b;border-color:#8a3442}
    #tsl-page .card small{display:block;color:var(--muted);font-size:10px;font-weight:700;
      letter-spacing:.06em;text-transform:uppercase}
    #tsl-page .card strong{display:block;margin-top:5px;font-size:clamp(14px,1.8vw,20px);
      overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
    #tsl-page .card strong.positive{color:var(--green)}
    #tsl-page .card strong.negative{color:#ff8a96}
    #tsl-page .trades{display:grid;width:100%;min-width:0;gap:6px;padding:0 20px 20px}
    #tsl-page .trade-card{display:block;width:100%;min-width:0;
      border:1px solid var(--line);border-radius:8px;background:var(--surface);overflow:hidden}
    #tsl-page .trade-card:nth-child(2n){background:#21181b}
    #tsl-page .trade-card:hover,#tsl-page .trade-card.selected{background:#49272f}
    #tsl-page .trade-main{display:grid;width:100%;min-width:0;
      grid-template-columns:repeat(auto-fit,minmax(min(100%,90px),1fr));
      gap:2px;padding:6px 7px;border:0!important;border-radius:0!important;
      background:transparent!important;color:var(--text)!important;text-align:center;
      white-space:normal!important;font-size:11.9px!important;line-height:1.25}
    #tsl-page .trade-main:focus-visible{outline:2px solid var(--red);outline-offset:-2px}
    #tsl-page .trade-cell,#tsl-page .trade-field{display:block;min-width:0;
      padding:5px 4px;text-align:center;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
    #tsl-page .trade-cell{padding:3px 2px}
    #tsl-page .trade-cell small,#tsl-page .trade-field small{display:block;margin-bottom:3px;color:var(--muted);
      font-size:10px;font-weight:700;text-transform:uppercase}
    #tsl-page .trade-cell small{font-size:9.2px!important;margin-bottom:2px}
    #tsl-page .trade-value{display:block;min-width:0;max-width:100%;white-space:normal;
      overflow-wrap:anywhere}
    #tsl-page .trade-cell .trade-value{font-weight:700}
    #tsl-page .trade-cell:first-child{display:grid;place-items:center}
    #tsl-page .trade-cell:first-child .trade-value{font-size:13.2px;font-weight:900}
    #tsl-page .trade-details{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,155px),1fr));
      gap:6px;padding:10px;border-top:1px solid var(--line);background:#170f12}
    #tsl-page .trade-details[hidden]{display:none}
    #tsl-page .buy{color:var(--green);font-weight:800}
    #tsl-page .sell,#tsl-page .negative{color:#ff96a0;font-weight:800}
    #tsl-page .positive{color:var(--green);font-weight:800}
    #tsl-page .edit{margin-left:5px;border:1px solid #8d5963!important;border-radius:5px;
      background:#342127!important;color:var(--text)!important}
    #tsl-page .edit-input{width:96px;max-width:100%;height:26px;padding:2px 5px}
    #tsl-page .note{padding:24px 20px;text-align:center;color:var(--muted)}
    #tsl-page .footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:14px;align-items:center;
      padding:12px 20px;border-top:1px solid var(--line);background:#1b1316;color:var(--muted)}
    #tsl-page #tsl-status{overflow-wrap:anywhere}
    @media(max-width:850px){
      #tsl-page .header,#tsl-page .toolbar,#tsl-page .filterbar{padding-left:12px;padding-right:12px}
      #tsl-page .tabs{padding-left:12px}
      #tsl-page .summary{padding-left:12px;padding-right:12px}
      #tsl-page .trades{padding-left:12px;padding-right:12px}
    }
  `);

  function makePage() {
    const page = document.createElement('section');
    page.id = 'tsl-page';
    page.innerHTML = `
      <div class="header">
        <div class="heading"><span class="mark">S</span>
          <div><h2>Torn Stock Ledger</h2><div class="subtitle">Trades · Costs · Profit</div></div>
        </div>
        <a class="back" href="/page.php?sid=stocks">Back to Stocks</a>
      </div>
      <div class="toolbar">
        <div class="toolbar-group">
          <label>View</label>
          <button class="button" type="button" data-days="7">7D</button>
          <button class="button" type="button" data-days="14">14D</button>
          <button class="button" type="button" data-days="30">30D</button>
          <button id="tsl-full" class="button" type="button">Full History</button>
        </div>
        <div class="toolbar-group">
          <label for="tsl-from">From</label><input id="tsl-from" type="date">
          <label for="tsl-to">To</label><input id="tsl-to" type="date">
          <button id="tsl-clear-dates" class="button" type="button">Clear Dates</button>
        </div>
        <span class="spacer"></span>
        <button id="tsl-pull" class="button primary" type="button">Pull Now</button>
      </div>
      <div class="toolbar secondary">
        <span class="spacer"></span>
        <div class="toolbar-group">
          <label for="tsl-key">Full Access API key</label>
          <input id="tsl-key" type="password" autocomplete="off" placeholder="Stored in Tampermonkey">
          <button id="tsl-test" class="button" type="button">Test Key</button>
        </div>
        <div class="toolbar-group">
          <button id="tsl-clear-manual" class="button" type="button">Clear Manual</button>
          <button id="tsl-clear-cache" class="button" type="button">Clear Cache</button>
        </div>
      </div>
      <div class="progress" id="tsl-progress" role="progressbar"
        aria-label="History dates checked" aria-valuemin="0" aria-valuemax="100"><span></span></div>
      <div class="filterbar">
        <label for="tsl-action">Action</label>
        <select id="tsl-action"><option value="ALL">All trades</option>
          <option value="BUY">Buys only</option><option value="SELL">Sells only</option></select>
        <button id="tsl-clear-filters" class="button" type="button">Clear Filters</button>
        <span class="spacer"></span><span id="tsl-count">No trades loaded</span>
      </div>
      <div id="tsl-tabs" class="tabs"></div>
      <div id="tsl-summary" class="summary"></div>
      <div id="tsl-results" class="trades">
        <div class="note">Select a date range or choose Full History.</div>
      </div>
      <div class="footer"><span id="tsl-status">Ready</span>
        <span>Made by Eaglewing [571041]</span></div>`;

    const find = (selector) => page.querySelector(selector);
    const keyInput = find('#tsl-key');
    const fromInput = find('#tsl-from');
    const toInput = find('#tsl-to');
    const progress = find('#tsl-progress');
    const status = find('#tsl-status');
    const action = find('#tsl-action');
    const savedRange = String(GM_getValue(KEY.range, '7'));
    const state = {
      days: ['7', '14', '30'].includes(savedRange) ? savedRange : '7',
      ticker: String(GM_getValue(KEY.ticker, 'ALL')),
      stockMap: readObject(KEY.stockMap), view: null, busy: false
    };
    keyInput.value = String(GM_getValue(KEY.api, ''));
    fromInput.value = String(GM_getValue(KEY.from, ''));
    toInput.value = String(GM_getValue(KEY.to, ''));

    function setStatus(message) { status.textContent = message; }
    function setBusy(busy) {
      state.busy = busy;
      page.querySelectorAll('#tsl-pull,#tsl-full,[data-days],#tsl-test').forEach(button => {
        button.disabled = busy;
      });
      progress.classList.toggle('running', busy);
      if (!busy) progress.classList.remove('measured');
    }
    function setProgress(start, end, message) {
      if (start != null) {
        const percent = Math.min(100, Math.floor(
          coveredSeconds(start, end) * 100 / (end - start + 1)));
        progress.classList.add('measured');
        progress.firstElementChild.style.width = percent + '%';
        progress.setAttribute('aria-valuenow', String(percent));
        setStatus(percent + '% of account dates checked · ' + message);
      } else {
        progress.classList.remove('measured');
        progress.removeAttribute('aria-valuenow');
        setStatus(message);
      }
    }
    function updateRangeButtons() {
      page.querySelectorAll('[data-days]').forEach(button => {
        button.classList.toggle('active',
          !fromInput.value && !toInput.value && button.dataset.days === state.days);
      });
    }
    updateRangeButtons();

    function addField(card, labelText, value, className = '', fieldClass = 'trade-field') {
      const field = document.createElement(fieldClass === 'trade-cell' ? 'span' : 'div');
      field.className = fieldClass;
      const label = document.createElement('small');
      label.textContent = labelText;
      const content = document.createElement('span');
      content.className = 'trade-value' + (className ? ' ' + className : '');
      content.textContent = value;
      if (labelText) field.appendChild(label);
      field.appendChild(content);
      card.appendChild(field);
      return content;
    }

    function render() {
      const view = state.view;
      if (!view) return;
      const logs = Object.values(readObject(KEY.logs))
        .filter(log => Number(log?.timestamp) <= view.to);
      const all = ledgerRows(logs, state.stockMap, readObject(KEY.manual))
        .filter(row => row.ts >= view.from && row.ts <= view.to);
      const tickers = [...new Set(all.map(row => row.ticker))].sort();
      if (state.ticker !== 'ALL' && !tickers.includes(state.ticker)) state.ticker = 'ALL';
      const tabs = find('#tsl-tabs');
      tabs.replaceChildren();
      for (const ticker of ['ALL', ...tickers]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tab' + (ticker === state.ticker ? ' active' : '');
        button.textContent = ticker;
        button.addEventListener('click', () => {
          state.ticker = ticker;
          GM_setValue(KEY.ticker, ticker);
          render();
        });
        tabs.appendChild(button);
      }

      const stockRows = all.filter(row => state.ticker === 'ALL' || row.ticker === state.ticker);
      const shown = stockRows.filter(row => action.value === 'ALL' || row.action === action.value);
      const sells = stockRows.filter(row => row.action === 'SELL');
      const totals = {
        buy: sells.reduce((sum, row) => sum + (row.cost ?? 0), 0),
        sell: sells.reduce((sum, row) => sum + row.net, 0),
        profit: sells.reduce((sum, row) => sum + (row.profit ?? 0), 0),
        fee: sells.reduce((sum, row) => sum + row.fee, 0)
      };
      const summary = find('#tsl-summary');
      summary.replaceChildren();
      for (const [label, value, special] of [
        ['Total Buy', totals.buy, false], ['Total Sell', totals.sell, false],
        ['Profit', totals.profit, true], ['Fees Paid', totals.fee, false]
      ]) {
        const card = document.createElement('div');
        card.className = 'card' + (special ? ' profit' : '');
        const caption = document.createElement('small');
        caption.textContent = label;
        const amount = document.createElement('strong');
        amount.textContent = currency(value);
        if (special) amount.className = value >= 0 ? 'positive' : 'negative';
        card.append(caption, amount);
        summary.appendChild(card);
      }
      find('#tsl-count').textContent =
        'Showing ' + quantity(shown.length) + ' of ' + quantity(stockRows.length) +
        ' trades · ' + view.label + ' · Select a row for details';

      const results = find('#tsl-results');
      results.replaceChildren();
      if (!shown.length) {
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = stockRows.length ?
          'No trades match the action filter.' : 'No stock trades found for ' + view.label + '.';
        results.appendChild(note);
        return;
      }
      for (const [index, entry] of shown.entries()) {
        const row = document.createElement('article');
        row.className = 'trade-card';
        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'trade-main';
        main.title = 'Show trade details';
        main.setAttribute('aria-expanded', 'false');
        const details = document.createElement('div');
        details.className = 'trade-details';
        details.id = 'tsl-details-' + index;
        details.hidden = true;
        main.setAttribute('aria-controls', details.id);
        main.addEventListener('click', event => {
          if (!event.ctrlKey && !event.metaKey) {
            results.querySelectorAll('.trade-main[aria-expanded="true"]').forEach(other => {
              if (other === main) return;
              other.setAttribute('aria-expanded', 'false');
              other.title = 'Show trade details';
              other.nextElementSibling.hidden = true;
              other.parentElement.classList.remove('selected');
            });
          }
          const open = main.getAttribute('aria-expanded') !== 'true';
          main.setAttribute('aria-expanded', String(open));
          main.title = open ? 'Hide trade details' : 'Show trade details';
          details.hidden = !open;
          row.classList.toggle('selected', open);
        });
        addField(main, '', entry.action, entry.action.toLowerCase(), 'trade-cell');
        addField(main, 'When', when(entry.ts), '', 'trade-cell');
        addField(main, 'Stock', entry.ticker, '', 'trade-cell');
        addField(main, 'Shares', quantity(entry.shares), '', 'trade-cell');
        addField(main, entry.action === 'BUY' ? 'Buy Price' : 'Sell Price',
          currency(entry.action === 'BUY' ? entry.buyPrice : entry.sellPrice, 2), '', 'trade-cell');
        addField(main, 'Profit', entry.profit == null ? '—' :
          (entry.profit > 0 ? '+' : '') + currency(entry.profit),
          entry.profit == null ? '' : entry.profit >= 0 ? 'positive' : 'negative', 'trade-cell');
        const buyCell = addField(details, 'Buy Price', currency(entry.buyPrice, 2));
        if (entry.manual) {
          buyCell.append(' (manual)');
        }
        if (entry.editable || entry.manual) {
          const edit = document.createElement('button');
          edit.type = 'button';
          edit.className = 'edit';
          edit.textContent = '✎';
          edit.title = 'Set or change buy price';
          edit.addEventListener('click', () => {
            buyCell.replaceChildren();
            const input = document.createElement('input');
            input.type = 'number';
            input.min = '0.01';
            input.step = '0.01';
            input.className = 'edit-input';
            input.value = entry.buyPrice ?? '';
            const save = document.createElement('button');
            save.type = 'button';
            save.className = 'edit';
            save.textContent = '✓';
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'edit';
            cancel.textContent = '×';
            const commit = () => {
              const price = Number(input.value);
              if (!Number.isFinite(price) || price <= 0) {
                setStatus('Enter a buy price greater than zero.');
                input.focus();
                return;
              }
              const manual = readObject(KEY.manual);
              manual[entry.id] = { buyPrice: price, ts: now() };
              GM_setValue(KEY.manual, manual);
              render();
            };
            save.addEventListener('click', commit);
            cancel.addEventListener('click', render);
            input.addEventListener('keydown', event => {
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') render();
            });
            buyCell.append(input, save, cancel);
            input.focus();
          });
          buyCell.appendChild(edit);
          if (entry.manual) {
            buyCell.addEventListener('contextmenu', event => {
              event.preventDefault();
              const manual = readObject(KEY.manual);
              delete manual[entry.id];
              GM_setValue(KEY.manual, manual);
              render();
            }, { once: true });
          }
        }
        addField(details, 'Sell Price', currency(entry.sellPrice, 2));
        addField(details, 'Gross (Sell)', entry.action === 'BUY' ? '—' : currency(entry.gross));
        addField(details, 'Fee (0.10%)', currency(entry.fee));
        addField(details, 'Total Buy', currency(entry.cost));
        addField(details, 'Total Sell', entry.action === 'BUY' ? 'N/A' : currency(entry.net));
        row.append(main, details);
        results.appendChild(row);
      }
    }

    function selectedRange() {
      const fromText = fromInput.value;
      const toText = toInput.value;
      if (fromText || toText) {
        if (!fromText || !toText) throw new Error('Choose both From and To dates.');
        const from = dateBoundary(fromText);
        const to = dateBoundary(toText, true);
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) ||
            from <= 0 || from > to || to > now() + DAY) {
          throw new Error('Choose a valid From and To date range.');
        }
        return { from, to: Math.min(to, now()), label: fromText + ' → ' + toText, fresh: false };
      }
      const to = now();
      return { from: to - Number(state.days) * DAY, to,
        label: 'last ' + state.days + ' days', fresh: true };
    }

    function currentKey() {
      const key = keyInput.value.trim();
      if (!key) throw new Error('Enter a Full Access API key first.');
      GM_setValue(KEY.api, key);
      return key;
    }

    async function pull() {
      if (state.busy) return;
      try {
        const key = currentKey();
        const view = selectedRange();
        state.view = view;
        setBusy(true);
        setProgress(null, null, 'Loading stock names…');
        state.stockMap = await stockMapFor(key, setStatus);
        const result = await importRange(key, view.from, view.to, view.fresh,
          progressReport => setProgress(null, null, progressReport.message));
        render();
        setStatus(view.label + ': ' + result.added + ' new trades cached in ' +
          result.requests + ' API requests.');
      } catch (error) {
        if (state.view) render();
        setStatus(error.message || String(error));
      } finally {
        setBusy(false);
      }
    }

    async function fullHistory() {
      if (state.busy) return;
      try {
        const key = currentKey();
        setBusy(true);
        setProgress(null, null, 'Reading your account creation date…');
        const from = await accountSignup(key, setStatus);
        const to = now();
        state.view = { from, to, label: 'Full History' };
        state.stockMap = await stockMapFor(key, setStatus);
        const result = await importRange(key, from, to, false,
          update => setProgress(from, to, update.message));
        render();
        setProgress(from, to, 'Full History: ' + result.added +
          ' new trades cached in ' + result.requests + ' API requests.');
      } catch (error) {
        if (state.view) render();
        setStatus('Full History: ' + (error.message || String(error)));
      } finally {
        setBusy(false);
      }
    }

    keyInput.addEventListener('change', () => {
      if (keyInput.value.trim()) GM_setValue(KEY.api, keyInput.value.trim());
    });
    for (const input of [fromInput, toInput]) {
      input.addEventListener('change', () => {
        GM_setValue(KEY.from, fromInput.value);
        GM_setValue(KEY.to, toInput.value);
        updateRangeButtons();
        if (fromInput.value && toInput.value && keyInput.value.trim()) pull();
      });
    }
    page.querySelectorAll('[data-days]').forEach(button => {
      button.addEventListener('click', () => {
        state.days = button.dataset.days;
        GM_setValue(KEY.range, state.days);
        fromInput.value = '';
        toInput.value = '';
        GM_setValue(KEY.from, '');
        GM_setValue(KEY.to, '');
        updateRangeButtons();
        if (keyInput.value.trim()) pull();
      });
    });
    find('#tsl-clear-dates').addEventListener('click', () => {
      fromInput.value = '';
      toInput.value = '';
      GM_setValue(KEY.from, '');
      GM_setValue(KEY.to, '');
      updateRangeButtons();
      setStatus('Custom dates cleared. Select 7D, 14D or 30D to load trades.');
    });
    find('#tsl-pull').addEventListener('click', pull);
    find('#tsl-full').addEventListener('click', fullHistory);
    action.addEventListener('change', render);
    find('#tsl-clear-filters').addEventListener('click', () => {
      action.value = 'ALL';
      state.ticker = 'ALL';
      GM_setValue(KEY.ticker, 'ALL');
      render();
    });
    find('#tsl-test').addEventListener('click', async () => {
      if (state.busy) return;
      try {
        const key = currentKey();
        setBusy(true);
        setStatus('Checking your API key…');
        const data = await apiJSON('/v2/user/profile', { key }, setStatus);
        setStatus('API key works' + (data.profile?.name ? ' for ' + data.profile.name : '') + '.');
      } catch (error) {
        setStatus('API key test: ' + (error.message || String(error)));
      } finally {
        setBusy(false);
      }
    });
    find('#tsl-clear-manual').addEventListener('click', () => {
      if (!confirm('Clear all manually entered buy prices?')) return;
      GM_setValue(KEY.manual, {});
      render();
      setStatus('Manual buy prices cleared.');
    });
    find('#tsl-clear-cache').addEventListener('click', () => {
      if (!confirm('Clear all cached stock trades and verified history dates? You will need to import them again.')) return;
      GM_setValue(KEY.logs, {});
      GM_setValue(KEY.coverage, []);
      render();
      setStatus('Cached trade history cleared.');
    });
    find('.back').addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      location.assign(STOCKS_URL);
    });
    // Show already cached trades without making an API request on page load.
    const cached = readObject(KEY.logs);
    if (Object.keys(cached).length) {
      try { state.view = selectedRange(); render(); } catch { /* Wait for both dates. */ }
    }
    return page;
  }

  function insertLink(stockRoot) {
    const header = stockRoot.querySelector('[class*="appHeaderWrapper"]');
    const title = header?.querySelector('[class*="titleContainer"] h4');
    const profit = title?.querySelector('.tt-total-stock-value');
    if (!profit) return false;
    let link = title.querySelector('#tsl-link');
    if (!link) {
      link = document.createElement('a');
      link.id = 'tsl-link';
      link.href = LEDGER_URL;
      link.textContent = 'Torn Stock Ledger';
      link.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        location.assign(LEDGER_URL);
      });
    }
    if (link.previousElementSibling !== profit) profit.after(link);
    return true;
  }

  function start() {
    if (location.pathname !== '/page.php' ||
        new URLSearchParams(location.search).get('sid') !== 'stocks') return;
    const dedicated = new URLSearchParams(location.search).get('ewStockLedger') === '1';
    let mounted = false;
    let scheduled = false;
    const mount = () => {
      const stockRoot = document.getElementById('stockmarketroot');
      if (!stockRoot) return;
      if (dedicated) {
        if (mounted) return;
        stockRoot.replaceWith(makePage());
        mounted = true;
        observer.disconnect();
      } else {
        insertLink(stockRoot);
      }
    };
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        mount();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    mount();
  }

  start();
})();
