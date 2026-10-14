// ==UserScript==
// @name         Torn Stock Ledger
// @namespace    https://github.com/Eaglewing91
// @version      1.1.0
// @author       Eaglewing [571041]
// @homepageURL  https://github.com/Eaglewing91/torn-day-trader-logbook
// @updateURL    https://raw.githubusercontent.com/Eaglewing91/torn-day-trader-logbook/main/torn-day-trader-logbook.user.js
// @downloadURL  https://raw.githubusercontent.com/Eaglewing91/torn-day-trader-logbook/main/torn-day-trader-logbook.user.js
// @description  View your Torn stock trades, costs, fees and profit for 7/14/30 days, custom dates or your full account history. Uses only your own API data; your key and trades are stored locally and never shared. Requires a Full Access API key (user log).
// @match        https://www.torn.com/page.php?sid=stocks*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @license      MIT
// ==/UserScript==

// Terms of Service
// | Data Storage            | Data Sharing | Purpose of Use                                   | Key Storage & Sharing                        | Key Access Level                                       |
// |-------------------------|--------------|--------------------------------------------------|----------------------------------------------|--------------------------------------------------------|
// | No / Only locally       | Nobody       | Non malicious statistical analysis (own stock    | Stored locally (Tampermonkey) / Not shared;  | Full (user log). Selections: user log, user profile,   |
// | (Tampermonkey storage)  |              | trade costs, fees and profit)                    | used only for api.torn.com calls             | torn stocks                                            |
//
// On the Stocks page a "Torn Stock Ledger" link is added to the header. On the
// ledger URL the stock application is replaced with the ledger page.
// Network use: only fetch() calls to api.torn.com. Nothing is requested from
// torn.com pages and no data is sent anywhere else.
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
  const RECENT_GAP = 60;          // seconds: the last minute is re-checked next time
  const FLUSH_EVERY = 10;         // API windows between cache writes
  const ROWS_PER_PAGE = 100;      // trades rendered per "Show more"
  const LOCK_STALE = 90000;       // ms before another tab's import lock is ignored
  const STOCK_MAP_TTL = 3600000;  // ms between stock-name refreshes for unknown IDs
  const TAB_ID = Math.random().toString(36).slice(2);

  // Earlier storage keys are kept so already-imported history carries over.
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
    signup: 'torn_stock_ledger_signup_v1',
    stockMapTs: 'torn_stock_ledger_stock_map_ts_v1',
    lock: 'torn_stock_ledger_import_lock_v1',
    compacted: 'torn_stock_ledger_compacted_v1'
  });

  let activeAbort = null;
  let lockHeld = false;

  class Cancelled extends Error {
    constructor() {
      super('Import cancelled. Everything fetched so far was saved.');
      this.name = 'Cancelled';
    }
  }

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
  // All dates and times use Torn City Time (UTC).
  const when = (timestamp) =>
    new Date(timestamp * 1000).toLocaleString(undefined, { timeZone: 'UTC' }) + ' TCT';
  const stamp = (timestamp) => new Date(timestamp * 1000).toISOString().slice(0, 19).replace('T', ' ');

  // Cancellable delay: rejects with Cancelled if the user presses Cancel.
  const wait = (ms) => new Promise((resolve, reject) => {
    const signal = activeAbort?.signal;
    if (signal?.aborted) return reject(new Cancelled());
    const onAbort = () => { clearTimeout(timer); reject(new Cancelled()); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  // Custom dates are read as Torn City Time (UTC), midnight to midnight.
  function dateBoundary(text, end = false) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return NaN;
    const [y, m, d] = text.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) return NaN;
    return Math.floor(date.getTime() / 1000);
  }

  // ---------- Import lock (stops two tabs overwriting each other's cache) ----------
  function acquireLock() {
    const lock = GM_getValue(KEY.lock, null);
    if (lock && lock.owner !== TAB_ID && Date.now() - Number(lock.ts) < LOCK_STALE) return false;
    GM_setValue(KEY.lock, { owner: TAB_ID, ts: Date.now() });
    lockHeld = true;
    return true;
  }
  function heartbeat() {
    if (lockHeld) GM_setValue(KEY.lock, { owner: TAB_ID, ts: Date.now() });
  }
  function releaseLock() {
    if (!lockHeld) return;
    if (GM_getValue(KEY.lock, null)?.owner === TAB_ID) GM_setValue(KEY.lock, null);
    lockHeld = false;
  }
  window.addEventListener('pagehide', releaseLock);

  // ---------- Coverage (which date ranges have been fully fetched) ----------
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

  // ---------- API ----------
  const API_ERRORS = {
    2: 'Incorrect API key. Check the key and try again.',
    10: 'This key\'s owner is in federal jail, so the key cannot be used.',
    13: 'This key is disabled because its owner has been inactive.',
    16: 'This key\'s access level is too low. Torn Stock Ledger needs a Full Access key to read your stock logs.',
    18: 'This key is paused. Unpause it in your Torn API settings.'
  };

  const attempts = [];
  async function apiJSON(path, params, report = () => {}) {
    const url = new URL(path, API);
    url.search = new URLSearchParams(params).toString();
    for (let retry = 0; retry < 4; retry++) {
      if (activeAbort?.signal.aborted) throw new Cancelled();
      const current = Date.now();
      while (attempts.length && current - attempts[0] >= 60000) attempts.shift();
      if (attempts.length >= 45) {
        const delay = 61000 - (current - attempts[0]);
        report('Waiting ' + Math.ceil(delay / 1000) + 's for the API request limit…');
        await wait(delay);
        while (attempts.length && Date.now() - attempts[0] >= 60000) attempts.shift();
      }
      attempts.push(Date.now());
      heartbeat();
      let response;
      let data;
      try {
        response = await fetch(url.href, { cache: 'no-store', signal: activeAbort?.signal });
        data = await response.json();
      } catch (error) {
        if (activeAbort?.signal.aborted) throw new Cancelled();
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
      if (data?.error) {
        throw new Error(API_ERRORS[data.error.code] ||
          'API error ' + data.error.code + ': ' + data.error.error);
      }
      if (!response.ok || !data) throw new Error('Unexpected API response (HTTP ' + response.status + ').');
      return data;
    }
    throw new Error('Could not reach the Torn API.');
  }

  // Stock names are cached, but refreshed (at most hourly) when a trade
  // references a stock ID the cache does not know, e.g. a newly added stock.
  async function stockMapFor(key, report) {
    const saved = readObject(KEY.stockMap);
    const used = new Set(Object.values(readObject(KEY.logs))
      .map(log => String(log?.data?.stock ?? '')).filter(Boolean));
    const unknown = [...used].some(id => !saved[id]);
    const fresh = Date.now() - Number(GM_getValue(KEY.stockMapTs, 0)) < STOCK_MAP_TTL;
    if (Object.keys(saved).length && (!unknown || fresh)) return saved;
    try {
      const data = await apiJSON('/torn/', { selections: 'stocks', key }, report);
      const map = { ...saved };
      for (const [id, stock] of Object.entries(data.stocks || {})) {
        map[id] = { acronym: stock.acronym || stock.name || id, name: stock.name || id };
      }
      GM_setValue(KEY.stockMap, map);
      GM_setValue(KEY.stockMapTs, Date.now());
      return map;
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      return saved;
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

  // Only the fields the ledger uses are stored, which keeps the cache small.
  function compactTrade(entry) {
    const d = entry?.data || {};
    return {
      id: String(entry.id), timestamp: Number(entry.timestamp), log: Number(entry.log),
      data: { stock: d.stock, amount: d.amount, price: d.price, worth: d.worth }
    };
  }

  function normalizeTrade(raw) {
    const id = raw?.id == null ? '' : String(raw.id);
    const timestamp = Number(raw?.timestamp);
    const type = Number(raw?.details?.id);
    if (!id || !Number.isSafeInteger(timestamp) || (type !== STOCK_BUY && type !== STOCK_SELL)) {
      throw new Error('The API returned an unexpected stock trade.');
    }
    return compactTrade({ id, timestamp, log: type, data: raw.data });
  }

  // One-time shrink of caches written by earlier versions.
  function migrateCache() {
    if (GM_getValue(KEY.compacted, false)) return;
    const cache = readObject(KEY.logs);
    const compacted = {};
    for (const [id, entry] of Object.entries(cache)) {
      if (entry && entry.id != null) compacted[id] = compactTrade(entry);
    }
    GM_setValue(KEY.logs, compacted);
    GM_setValue(KEY.compacted, true);
  }

  // Fetches every date range not yet covered between start and end. Trades and
  // coverage are written together in batches, so an interrupted import never
  // marks dates as checked without their trades being saved. The final minute
  // is never marked covered, so trades still being logged are picked up later.
  async function importRange(key, start, end, report) {
    const cap = Math.min(end, now() - RECENT_GAP);
    const queue = windowsFor(missingIntervals(start, end));
    const total = queue.reduce((sum, [a, b]) => sum + (b - a + 1), 0);
    const cache = readObject(KEY.logs);
    let covered = [];
    let dirty = 0;
    let done = 0;
    let requests = 0;
    let added = 0;
    const percent = () => total ? Math.min(100, Math.floor(done * 100 / total)) : 100;
    const flush = () => {
      if (!dirty && !covered.length) return;
      GM_setValue(KEY.logs, cache);
      if (covered.length) GM_setValue(KEY.coverage, normalizeCoverage([...coverage(), ...covered]));
      covered = [];
      dirty = 0;
    };
    try {
      while (queue.length) {
        const [first, last] = queue[0];
        report({ percent: percent(), message: 'Checking ' + new Date(first * 1000).toLocaleDateString() +
          ' – ' + new Date(last * 1000).toLocaleDateString() + '…' });
        const data = await apiJSON('/v2/user/log', {
          log: STOCK_BUY + ',' + STOCK_SELL, limit: PAGE_LIMIT, from: first, to: last, key
        }, message => report({ percent: percent(), message }));
        if (!Array.isArray(data.log) || !data._metadata?.links || !('next' in data._metadata.links)) {
          throw new Error('The stock log API response was incomplete. Progress was saved.');
        }
        requests++;
        const entries = data.log.map(normalizeTrade);
        if (entries.some(entry => entry.timestamp < first || entry.timestamp > last)) {
          throw new Error('The API returned trades outside the requested dates. Progress was saved.');
        }
        for (const entry of entries) {
          if (!cache[entry.id]) added++;
          cache[entry.id] = entry;
        }
        dirty++;
        if (entries.length >= PAGE_LIMIT || data._metadata.links.next) {
          if (first === last) throw new Error('More than 100 trades occurred in one second. Progress was saved.');
          const middle = first + Math.floor((last - first) / 2);
          queue.splice(0, 1, [middle + 1, last], [first, middle]);
          continue;
        }
        const coveredEnd = Math.min(last, cap);
        if (coveredEnd >= first) covered.push([first, coveredEnd]);
        done += last - first + 1;
        queue.shift();
        if (dirty >= FLUSH_EVERY) flush();
        report({ percent: percent(), message: requests + ' requests · ' + added + ' new trades · ' +
          queue.length + ' windows left' });
      }
    } finally {
      flush();
    }
    return { requests, added };
  }

  // ---------- Ledger maths (average cost per stock) ----------
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
          ...event, buyPrice: event.price, sellPrice: null, gross: null, fee: 0,
          cost: event.spent, net: null, profit: null, manual: false, editable: false,
          tracked: 0, untracked: 0, trackedAvg: null
        });
        continue;
      }
      const gross = Math.round((event.price ?? 0) * 100) * event.shares / 100;
      const fee = Math.ceil(gross * 0.001);
      const net = Math.floor(gross - fee);
      // Shares covered by tracked buys use the average cost; any extra
      // (untracked) shares need a manually entered buy price.
      const tracked = Math.min(lot.shares, event.shares);
      const untracked = event.shares - tracked;
      const trackedAvg = lot.shares > 0 ? lot.cost / lot.shares : null;
      const trackedCost = tracked > 0 ? trackedAvg * tracked : 0;
      if (tracked > 0) {
        lot.shares -= tracked;
        lot.cost -= trackedCost;
        if (lot.shares <= 0) { lot.shares = 0; lot.cost = 0; }
      }
      let cost = null;
      let manualUsed = false;
      if (untracked === 0) {
        cost = trackedCost;
      } else {
        const override = Number(manual[event.id]?.buyPrice);
        if (Number.isFinite(override) && override > 0) {
          cost = trackedCost + override * untracked;
          manualUsed = true;
        }
      }
      rows.push({
        ...event, buyPrice: cost == null ? null : cost / event.shares, sellPrice: event.price,
        gross: net + fee, fee, cost, net, profit: cost == null ? null : net - cost,
        manual: manualUsed, editable: untracked > 0,
        tracked, untracked, trackedAvg: tracked > 0 ? trackedAvg : null
      });
    }
    return { rows: rows.reverse(), holdings };
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
    #tsl-page [hidden]{display:none!important}
    #tsl-page button,#tsl-page input,#tsl-page select{font:inherit}
    #tsl-page button{cursor:pointer}
    #tsl-page .header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:20px;
      padding:20px 24px;background:linear-gradient(110deg,#34191e,#1c1316 57%,#110d0f);
      border-bottom:1px solid #72353f}
    #tsl-page .heading{display:flex;align-items:center;gap:13px;min-width:0}
    #tsl-page .mark{display:grid;place-items:center;width:35px;height:35px;border-radius:9px;
      background:var(--red);color:#1a080c;font-size:20px;font-weight:900}
    #tsl-page h2{margin:0;color:var(--text);font-size:18px;line-height:1.2}
    #tsl-page h3{margin:0 0 8px;color:var(--text);font-size:13px}
    #tsl-page .subtitle{color:#d7a5ad;font-size:11px;letter-spacing:.09em;text-transform:uppercase}
    #tsl-page .back{color:#ff8790!important;white-space:nowrap;text-decoration:none;font-weight:700}
    #tsl-page .back:hover{text-decoration:underline}
    #tsl-page .toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:9px;padding:12px 20px;
      background:var(--surface);border-bottom:1px solid var(--line)}
    #tsl-page .toolbar.dates{background:#1b1215}
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
    #tsl-page .card .roi{display:block;margin-top:4px;font-size:12px;font-weight:700}
    #tsl-page .card .roi.positive{color:var(--green)}
    #tsl-page .card .roi.negative{color:#ff8a96}
    #tsl-page .missing{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 20px 12px;
      padding:9px 12px;border:1px solid #9a6b2f;border-radius:8px;background:#2a1f12;color:#f3d7a8}
    #tsl-page .positions{padding:0 20px 14px}
    #tsl-page .position-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));gap:8px}
    #tsl-page .position{padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:#161012;
      font-variant-numeric:tabular-nums}
    #tsl-page .position b{display:block;font-size:13px;margin-bottom:3px}
    #tsl-page .position span{display:block;color:var(--muted);font-size:11px}
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
    #tsl-page .buy{color:var(--green);font-weight:800}
    #tsl-page .sell,#tsl-page .negative{color:#ff96a0;font-weight:800}
    #tsl-page .positive{color:var(--green);font-weight:800}
    #tsl-page .warn{color:#f3c27a;font-weight:800}
    #tsl-page .edit{margin-left:5px;border:1px solid #8d5963!important;border-radius:5px;
      background:#342127!important;color:var(--text)!important}
    #tsl-page .edit-input{width:96px;max-width:100%;height:26px;padding:2px 5px}
    #tsl-page .more{justify-self:center;margin-top:6px}
    #tsl-page .note{padding:24px 20px;text-align:center;color:var(--muted)}
    #tsl-page .footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:14px;align-items:center;
      padding:12px 20px;border-top:1px solid var(--line);background:#1b1316;color:var(--muted)}
    #tsl-page #tsl-status{overflow-wrap:anywhere}
    @media(max-width:850px){
      #tsl-page .header,#tsl-page .toolbar,#tsl-page .filterbar{padding-left:12px;padding-right:12px}
      #tsl-page .tabs{padding-left:12px}
      #tsl-page .summary,#tsl-page .positions,#tsl-page .trades{padding-left:12px;padding-right:12px}
      #tsl-page .missing{margin-left:12px;margin-right:12px}
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
        <span class="spacer"></span>
        <button id="tsl-cancel" class="button" type="button" hidden>Cancel</button>
        <button id="tsl-pull" class="button primary" type="button">Refresh View</button>
      </div>
      <div class="toolbar dates">
        <div class="toolbar-group">
          <label>Custom dates</label>
          <label for="tsl-from">From</label><input id="tsl-from" type="date">
          <label for="tsl-to">To</label><input id="tsl-to" type="date">
          <button id="tsl-pull-dates" class="button" type="button">Pull Dates</button>
          <button id="tsl-clear-dates" class="button" type="button">Clear Dates</button>
        </div>
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
          <option value="BUY">Buys only</option><option value="SELL">Sells only</option>
          <option value="MISSING">Sells missing buy price</option></select>
        <button id="tsl-clear-filters" class="button" type="button">Clear Filters</button>
        <button id="tsl-export" class="button" type="button" title="Download the trades matching the current view and filters">Export CSV</button>
        <span class="spacer"></span><span id="tsl-count">No trades loaded</span>
      </div>
      <div id="tsl-tabs" class="tabs"></div>
      <div id="tsl-summary" class="summary"></div>
      <div id="tsl-missing" class="missing" hidden></div>
      <div id="tsl-positions" class="positions" hidden></div>
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
      stockMap: readObject(KEY.stockMap), view: null, busy: false, shown: []
    };
    keyInput.value = String(GM_getValue(KEY.api, ''));
    fromInput.value = String(GM_getValue(KEY.from, ''));
    toInput.value = String(GM_getValue(KEY.to, ''));

    function setStatus(message) { status.textContent = message; }
    function setBusy(busy) {
      state.busy = busy;
      page.querySelectorAll('#tsl-pull,#tsl-pull-dates,#tsl-clear-dates,#tsl-from,#tsl-to,' +
        '#tsl-full,[data-days],#tsl-test,#tsl-clear-cache').forEach(button => {
        button.disabled = busy;
      });
      find('#tsl-cancel').hidden = !busy;
      progress.classList.toggle('running', busy);
      if (!busy) progress.classList.remove('measured');
    }
    function setProgress(percent, message) {
      if (percent != null) {
        progress.classList.add('measured');
        progress.firstElementChild.style.width = percent + '%';
        progress.setAttribute('aria-valuenow', String(percent));
        setStatus(percent + '% checked · ' + message);
      } else {
        progress.classList.remove('measured');
        progress.removeAttribute('aria-valuenow');
        setStatus(message);
      }
    }
    function updateRangeButtons() {
      const mode = state.view?.mode ?? (fromInput.value && toInput.value ? null : 'days');
      page.querySelectorAll('[data-days]').forEach(button => {
        button.classList.toggle('active', mode === 'days' && button.dataset.days === state.days);
      });
      find('#tsl-full').classList.toggle('active', mode === 'full');
      find('#tsl-pull-dates').classList.toggle('active', mode === 'dates');
      find('#tsl-pull').textContent = mode === 'full' ? 'Refresh Full History' :
        mode === 'dates' ? 'Refresh Dates' :
          mode === 'days' ? 'Refresh ' + state.days + 'D' : 'Refresh View';
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

    function smallButton(text, title, onClick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'edit';
      button.textContent = text;
      if (title) button.title = title;
      button.addEventListener('click', onClick);
      return button;
    }

    function saveManual(id, price) {
      const manual = readObject(KEY.manual);
      if (price == null) delete manual[id];
      else manual[id] = { buyPrice: price, ts: now() };
      GM_setValue(KEY.manual, manual);
      render();
    }

    function buildRow(entry, index, results) {
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
      const missing = entry.action === 'SELL' && entry.cost == null;
      addField(main, '', entry.action, entry.action.toLowerCase(), 'trade-cell');
      addField(main, 'When', when(entry.ts), '', 'trade-cell');
      addField(main, 'Stock', entry.ticker, '', 'trade-cell');
      addField(main, 'Shares', quantity(entry.shares), '', 'trade-cell');
      addField(main, entry.action === 'BUY' ? 'Buy Price' : 'Sell Price',
        currency(entry.action === 'BUY' ? entry.buyPrice : entry.sellPrice, 2), '', 'trade-cell');
      addField(main, 'Profit', missing ? 'Needs buy price' : entry.profit == null ? '—' :
        (entry.profit > 0 ? '+' : '') + currency(entry.profit),
        missing ? 'warn' : entry.profit == null ? '' : entry.profit >= 0 ? 'positive' : 'negative', 'trade-cell');

      const buyCell = addField(details, 'Avg Buy Price', currency(entry.buyPrice, 2));
      if (entry.manual) buyCell.append(' (manual)');
      if (entry.editable) {
        const manualPrice = Number(readObject(KEY.manual)[entry.id]?.buyPrice) || '';
        buyCell.appendChild(smallButton('✎', 'Set the buy price for the ' +
          quantity(entry.untracked) + ' untracked shares', () => {
          buyCell.replaceChildren();
          const input = document.createElement('input');
          input.type = 'number';
          input.min = '0.01';
          input.step = '0.01';
          input.className = 'edit-input';
          input.value = manualPrice;
          input.title = 'Buy price per share for the ' + quantity(entry.untracked) + ' untracked shares';
          const commit = () => {
            const price = Number(input.value);
            if (!Number.isFinite(price) || price <= 0) {
              setStatus('Enter a buy price greater than zero.');
              input.focus();
              return;
            }
            saveManual(entry.id, price);
          };
          input.addEventListener('keydown', event => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') render();
          });
          buyCell.append(input, smallButton('✓', 'Save', commit), smallButton('×', 'Cancel', render));
          input.focus();
        }));
        if (entry.manual) {
          buyCell.appendChild(smallButton('↺ Reset', 'Remove the manual buy price',
            () => saveManual(entry.id, null)));
        }
      }
      if (entry.action === 'SELL' && entry.untracked > 0) {
        addField(details, 'Untracked Shares', quantity(entry.untracked) +
          (entry.tracked ? ' (' + quantity(entry.tracked) + ' tracked at ' +
            currency(entry.trackedAvg, 2) + ')' : ''), 'warn');
      }
      addField(details, 'Sell Price', currency(entry.sellPrice, 2));
      addField(details, 'Gross (Sell)', entry.action === 'BUY' ? '—' : currency(entry.gross));
      addField(details, 'Fee (0.10%)', currency(entry.fee));
      addField(details, 'Total Cost', currency(entry.cost));
      addField(details, 'Net Proceeds', entry.action === 'BUY' ? 'N/A' : currency(entry.net));
      row.append(main, details);
      return row;
    }

    function renderRows(results, rows, start) {
      results.querySelector('.more')?.remove();
      const end = Math.min(rows.length, start + ROWS_PER_PAGE);
      for (let i = start; i < end; i++) results.appendChild(buildRow(rows[i], i, results));
      if (end < rows.length) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'button more';
        more.textContent = 'Show ' + quantity(Math.min(ROWS_PER_PAGE, rows.length - end)) +
          ' more (' + quantity(rows.length - end) + ' remaining)';
        more.addEventListener('click', () => renderRows(results, rows, end));
        results.appendChild(more);
      }
    }

    function render() {
      const view = state.view;
      if (!view) return;
      const logs = Object.values(readObject(KEY.logs)).filter(log => Number(log?.timestamp) <= view.to);
      const ledger = ledgerRows(logs, state.stockMap, readObject(KEY.manual));
      const all = ledger.rows.filter(row => row.ts >= view.from && row.ts <= view.to);
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
      const shown = stockRows.filter(row =>
        action.value === 'ALL' ? true :
          action.value === 'MISSING' ? row.action === 'SELL' && row.cost == null :
            row.action === action.value);
      state.shown = shown;
      const sells = stockRows.filter(row => row.action === 'SELL');
      const complete = sells.filter(row => row.cost != null);
      const incomplete = sells.length - complete.length;
      // Totals use only sells with a known buy price, so cost, proceeds and
      // profit always describe the same set of trades.
      const totals = {
        cost: complete.reduce((sum, row) => sum + row.cost, 0),
        net: complete.reduce((sum, row) => sum + row.net, 0),
        profit: complete.reduce((sum, row) => sum + row.profit, 0),
        fee: sells.reduce((sum, row) => sum + row.fee, 0),
        bought: stockRows.filter(row => row.action === 'BUY').reduce((sum, row) => sum + row.spent, 0)
      };
      const summary = find('#tsl-summary');
      summary.replaceChildren();
      for (const [label, value, title, special] of [
        ['Buy Cost', totals.cost, 'Average buy cost of the shares sold in this range'],
        ['Sell Proceeds', totals.net, 'What those sales paid out after the 0.1% fee'],
        ['Profit', totals.profit, 'Sell proceeds minus buy cost', true],
        ['Fees Paid', totals.fee, 'Sale fees on every sell in this range']
      ]) {
        const card = document.createElement('div');
        card.className = 'card' + (special ? ' profit' : '');
        card.title = title;
        const caption = document.createElement('small');
        caption.textContent = label;
        const amount = document.createElement('strong');
        amount.textContent = currency(value);
        if (special) amount.className = value >= 0 ? 'positive' : 'negative';
        card.append(caption, amount);
        if (special) {
          const roi = totals.cost > 0 ? totals.profit / totals.cost * 100 : null;
          const percentage = document.createElement('span');
          percentage.className = 'roi' + (roi == null ? '' : roi >= 0 ? ' positive' : ' negative');
          percentage.textContent = 'ROI: ' + (roi == null ? '—' :
            (roi > 0 ? '+' : '') + roi.toLocaleString(undefined, {
              minimumFractionDigits: 2, maximumFractionDigits: 2
            }) + '%');
          card.appendChild(percentage);
        }
        summary.appendChild(card);
      }

      const missingBox = find('#tsl-missing');
      missingBox.replaceChildren();
      missingBox.hidden = !incomplete;
      if (incomplete) {
        const text = document.createElement('span');
        text.textContent = quantity(incomplete) + (incomplete === 1 ? ' sell is' : ' sells are') +
          ' missing a buy price and left out of the totals above.';
        missingBox.append(text, smallButton('Show them', 'Show sells missing a buy price', () => {
          action.value = 'MISSING';
          render();
        }));
      }

      const positions = [...ledger.holdings.entries()]
        .filter(([ticker, lot]) => lot.shares > 0 && (state.ticker === 'ALL' || ticker === state.ticker))
        .sort((a, b) => a[0].localeCompare(b[0]));
      const positionBox = find('#tsl-positions');
      positionBox.replaceChildren();
      positionBox.hidden = !positions.length;
      if (positions.length) {
        const heading = document.createElement('h3');
        heading.textContent = 'Open positions at end of range (from tracked trades)';
        const grid = document.createElement('div');
        grid.className = 'position-grid';
        for (const [ticker, lot] of positions) {
          const card = document.createElement('div');
          card.className = 'position';
          const name = document.createElement('b');
          name.textContent = ticker;
          const shares = document.createElement('span');
          shares.textContent = quantity(lot.shares) + ' shares';
          const avg = document.createElement('span');
          avg.textContent = 'Avg ' + currency(lot.cost / lot.shares, 2) + ' · ' + currency(lot.cost);
          card.append(name, shares, avg);
          grid.appendChild(card);
        }
        positionBox.append(heading, grid);
      }

      find('#tsl-count').textContent =
        'Showing ' + quantity(shown.length) + ' of ' + quantity(stockRows.length) +
        ' trades · Bought in range ' + currency(totals.bought) + ' · ' + view.label;

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
      renderRows(results, shown, 0);
    }

    function exportCsv() {
      const rows = state.shown;
      if (!state.view || !rows.length) {
        setStatus('Nothing to export for the current view and filters.');
        return;
      }
      const cell = (value) => {
        const text = value == null ? '' : String(value);
        return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
      };
      const money = (value) => value == null ? '' : Math.round(value * 100) / 100;
      const lines = [[
        'Date (TCT)', 'Action', 'Stock', 'Shares',
        'Avg Buy Price', 'Sell Price', 'Gross', 'Fee', 'Total Cost', 'Net Proceeds', 'Profit',
        'Manual Buy Price', 'Untracked Shares'
      ]];
      for (const row of [...rows].reverse()) {
        lines.push([
          stamp(row.ts), row.action, row.ticker, row.shares, money(row.buyPrice), money(row.sellPrice),
          money(row.gross), row.action === 'SELL' ? row.fee : '', money(row.cost), money(row.net),
          money(row.profit), row.manual ? 'yes' : '', row.untracked || ''
        ]);
      }
      const csv = '﻿' + lines.map(line => line.map(cell).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'torn-stock-ledger-' + stamp(now()).slice(0, 10) + '.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('Exported ' + quantity(rows.length) + ' trades to CSV.');
    }

    function selectedRange(mode) {
      if (mode !== 'dates') {
        const to = now();
        return { from: to - Number(state.days) * DAY, to,
          label: 'last ' + state.days + ' days', mode: 'days' };
      }
      const fromText = fromInput.value;
      const toText = toInput.value;
      if (!fromText || !toText) throw new Error('Choose both From and To dates.');
      const from = dateBoundary(fromText);
      const to = dateBoundary(toText, true);
      const current = now();
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) ||
          from <= 0 || from > to || from > current) {
        throw new Error('Choose a valid date range starting no later than today.');
      }
      return { from, to: Math.min(to, current),
        label: fromText + ' → ' + toText + ' TCT' +
          (to > current ? ' (through today)' : ''),
        mode: 'dates' };
    }

    function currentKey() {
      const key = keyInput.value.trim();
      if (!key) throw new Error('Enter a Full Access API key first.');
      GM_setValue(KEY.api, key);
      return key;
    }

    // Every view imports from account creation, so each sell can be matched
    // with its earlier buys. After the first run only new dates are fetched.
    async function pull(mode) {
      if (state.busy) return;
      let key;
      try {
        key = currentKey();
        if (mode === 'dates') selectedRange('dates');
      } catch (error) {
        setStatus(error.message);
        return;
      }
      if (!acquireLock()) {
        setStatus('An import is already running in another Torn tab. Let it finish, then try again here.');
        return;
      }
      activeAbort = new AbortController();
      try {
        setBusy(true);
        setProgress(null, 'Reading your account creation date…');
        const signup = await accountSignup(key, setStatus);
        const view = mode === 'full' ?
          { from: signup, to: now(), label: 'Full History', mode: 'full' } : selectedRange(mode);
        state.view = view;
        updateRangeButtons();
        if (missingIntervals(signup, view.to).length > 1 || !coverage().length) {
          setProgress(null, 'Fetching your earlier trades once so every sell has a buy price…');
        }
        const result = signup > view.to ? { requests: 0, added: 0 } :
          await importRange(key, signup, view.to, update => setProgress(update.percent, update.message));
        setProgress(null, 'Loading stock names…');
        state.stockMap = await stockMapFor(key, setStatus);
        render();
        setStatus(view.label + ': ' + result.added + ' new trades cached in ' +
          result.requests + ' API requests.');
      } catch (error) {
        state.stockMap = readObject(KEY.stockMap);
        if (state.view) render();
        setStatus(error.message || String(error));
      } finally {
        activeAbort = null;
        releaseLock();
        setBusy(false);
      }
    }

    keyInput.addEventListener('change', () => {
      // An empty field removes the saved key, as the ToS panel states.
      GM_setValue(KEY.api, keyInput.value.trim());
      if (!keyInput.value.trim()) setStatus('Saved API key removed.');
    });
    for (const input of [fromInput, toInput]) {
      input.addEventListener('change', () => {
        GM_setValue(KEY.from, fromInput.value);
        GM_setValue(KEY.to, toInput.value);
        setStatus('Dates changed. Click Pull Dates to update trades and totals.');
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
        if (keyInput.value.trim()) pull('days');
        else {
          state.view = selectedRange('days');
          updateRangeButtons();
          render();
        }
      });
    });
    find('#tsl-clear-dates').addEventListener('click', () => {
      fromInput.value = '';
      toInput.value = '';
      GM_setValue(KEY.from, '');
      GM_setValue(KEY.to, '');
      if (state.view?.mode === 'dates') {
        if (keyInput.value.trim()) pull('days');
        else {
          state.view = selectedRange('days');
          updateRangeButtons();
          render();
          setStatus('Custom dates cleared. Showing cached ' + state.days + 'D trades.');
        }
      } else {
        updateRangeButtons();
        setStatus(state.view ? 'Custom dates cleared. Current view unchanged.' :
          'Custom dates cleared. Choose 7D, 14D or 30D to load trades.');
      }
    });
    find('#tsl-pull-dates').addEventListener('click', () => pull('dates'));
    find('#tsl-pull').addEventListener('click', () => {
      pull(state.view?.mode ?? (fromInput.value && toInput.value ? 'dates' : 'days'));
    });
    find('#tsl-full').addEventListener('click', () => pull('full'));
    find('#tsl-cancel').addEventListener('click', () => {
      if (activeAbort) {
        activeAbort.abort();
        setStatus('Cancelling…');
      }
    });
    action.addEventListener('change', render);
    find('#tsl-export').addEventListener('click', exportCsv);
    find('#tsl-clear-filters').addEventListener('click', () => {
      action.value = 'ALL';
      state.ticker = 'ALL';
      GM_setValue(KEY.ticker, 'ALL');
      render();
    });
    // Tests the access the ledger actually needs: reading the stock log.
    find('#tsl-test').addEventListener('click', async () => {
      if (state.busy) return;
      try {
        const key = currentKey();
        setBusy(true);
        setStatus('Checking your API key…');
        await apiJSON('/v2/user/log', { log: STOCK_BUY + ',' + STOCK_SELL, limit: 1, key }, setStatus);
        setStatus('API key works and can read your stock logs.');
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

    // Show already cached trades without making any request on page load.
    if (Object.keys(readObject(KEY.logs)).length) {
      try {
        const view = selectedRange(fromInput.value && toInput.value ? 'dates' : 'days');
        state.view = view;
        updateRangeButtons();
        render();
        const signup = Number(GM_getValue(KEY.signup, 0));
        const earlierComplete = signup > 0 &&
          (signup >= view.from || !missingIntervals(signup, view.from - 1).length);
        setStatus(earlierComplete ? 'Showing cached trades. Click Refresh to fetch anything new.' :
          'Showing cached trades. Earlier history is not fully loaded, so some buy prices may be ' +
          'missing. Click Refresh to complete it.');
      } catch {
        setStatus('Check both custom dates, then click Pull Dates.');
      }
    } else if (fromInput.value && toInput.value) {
      setStatus('Custom dates saved. Click Pull Dates to load accurate totals.');
    }
    return page;
  }

  // Adds the ledger link next to TornTools' stock value when present,
  // otherwise at the end of Torn's own Stocks page title.
  function insertLink(stockRoot) {
    const header = stockRoot.querySelector('[class*="appHeaderWrapper"]');
    const title = header?.querySelector('[class*="titleContainer"] h4') || header?.querySelector('h4');
    if (!title) return false;
    let link = document.getElementById('tsl-link');
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
    const profit = title.querySelector('.tt-total-stock-value');
    if (profit) {
      if (link.previousElementSibling !== profit) profit.after(link);
    } else if (link.parentElement !== title) {
      title.appendChild(link);
    }
    return true;
  }

  function start() {
    const params = new URLSearchParams(location.search);
    if (location.pathname !== '/page.php' || params.get('sid') !== 'stocks') return;
    const dedicated = params.get('ewStockLedger') === '1';
    let scheduled = false;
    let watchingRoot = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        mount();
      });
    });
    // DOM-only: the observer never triggers a network request. Once the stock
    // app exists it watches only that app (to re-add the link after re-renders).
    function mount() {
      const stockRoot = document.getElementById('stockmarketroot');
      if (!stockRoot) return;
      if (dedicated) {
        observer.disconnect();
        migrateCache();
        stockRoot.replaceWith(makePage());
        return;
      }
      insertLink(stockRoot);
      if (!watchingRoot) {
        watchingRoot = true;
        observer.disconnect();
        observer.observe(stockRoot, { childList: true, subtree: true });
      }
    }
    observer.observe(document.body, { childList: true, subtree: true });
    mount();
  }

  start();
})();
