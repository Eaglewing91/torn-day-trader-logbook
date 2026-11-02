"""Rebuilds the GitHub Pages site (docs/app.js, docs/style.css) from torn-day-trader-logbook.user.js.
Run after changing the userscript:  python3 tools/build-site.py"""
import re, sys
import os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') + os.sep
src = open(ROOT + 'torn-day-trader-logbook.user.js').read()
version = re.search(r'@version\s+(\S+)', src).group(1)

def cut(s, start, end, new, include_end=False):
    i = s.index(start); j = s.index(end, i)
    if include_end: j += len(end)
    return s[:i] + new + s[j:]

def rep(s, a, b):
    assert s.count(a) == 1, ('not unique/missing', a[:80], s.count(a))
    return s.replace(a, b)

body = src[src.index('(function () {'):]

# 1. CSS out of GM_addStyle into style.css
css_start = body.index('  GM_addStyle(`'); css_end = body.index('  `);\n', css_start)
css = body[css_start + len('  GM_addStyle(`'):css_end]
body = body[:css_start] + body[css_end + len('  `);\n'):]

# 2. Storage keys and storage shim (browser storage instead of Tampermonkey)
body = cut(body, "  // Earlier storage keys are kept", "  const API_COMMENT", """  const KEY = Object.freeze({
    api: 'apiKey', remember: 'rememberKey', range: 'range', from: 'customFrom', to: 'customTo',
    stockMap: 'stockMap', manual: 'manualBuys', ticker: 'ticker', logs: 'trades', coverage: 'coverage',
    signup: 'signup', stockMapTs: 'stockMapTs', lock: 'importLock', compacted: 'compacted',
    pause: 'apiPause', v1Query: 'v1QueryKey', queryMode: 'keyInAddress'
  });

  // ---------- Storage (this browser only; nothing is stored on a server) ----------
  // Same calls as the userscript's Tampermonkey storage. The API key is only
  // written to browser storage when "Remember key" is ticked; otherwise it is
  // kept in memory and forgotten when the page closes.
  const PREFIX = 'tsl:';
  const memory = Object.create(null);
  const rememberKey = () => GM_getValue(KEY.remember, true) !== false;
  function GM_getValue(name, fallback) {
    if (name in memory) return memory[name];
    try {
      const raw = localStorage.getItem(PREFIX + name);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  function GM_setValue(name, value) {
    if (name === KEY.api && !rememberKey()) {
      memory[name] = value;
      try { localStorage.removeItem(PREFIX + name); } catch {}
      return;
    }
    delete memory[name];
    try {
      localStorage.setItem(PREFIX + name, JSON.stringify(value));
    } catch (error) {
      if (error?.name === 'QuotaExceededError') {
        throw new Error('This browser\\'s storage for the site is full, so the trades could not be saved. ' +
          'Use Backup to keep a copy, then Clear Cache or free up site storage.');
      }
      memory[name] = value; // storage blocked (e.g. private mode): keep it for this visit only
    }
  }
  // Another tab changed storage: drop in-memory copies so this tab reads fresh values.
  window.addEventListener('storage', event => {
    if (event.key?.startsWith(PREFIX)) delete memory[event.key.slice(PREFIX.length)];
  });

""")
body = cut(body, "  // TornPDA swaps this placeholder", "  let activeAbort", "")
body = rep(body, "  const STOCKS_URL = '/page.php?sid=stocks';\n  const LEDGER_URL = STOCKS_URL + '&ewStockLedger=1';\n",
           "  const TORN_STOCKS = 'https://www.torn.com/page.php?sid=stocks';\n")

# 3. Transport: fetch only, key in the Authorization header with an address fallback
body = cut(body, "  // One GET request.", "  const attempts = [];", """  // One GET request from the browser. No cookies or referrer are sent.
  function httpGet(url, headers) {
    const signal = activeAbort?.signal;
    if (signal?.aborted) return Promise.reject(new Cancelled());
    return fetch(url, { headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal })
      .then(async r => ({ status: r.status, text: await r.text(), header: (name) => r.headers.get(name) }));
  }

""")
body = rep(body, """  // The key travels in the Authorization header. keyInQuery is only used if
  // Torn's v1 endpoint rejects the header (see stockMapFor).
  async function apiJSON(path, params, report = () => {}, { key, keyInQuery = false } = {}) {
    const url = new URL(path, API);
    const query = new URLSearchParams({ ...params, comment: API_COMMENT });
    if (keyInQuery) query.set('key', key);
    url.search = query.toString();
    const headers = keyInQuery ? {} : { Authorization: 'ApiKey ' + key };
    for (let retry = 0; retry < 4; retry++) {""", """  // The key travels in the Authorization header. If the browser blocks that
  // header for api.torn.com (a cross-site rule websites have and userscripts
  // don't), the key is sent in the request address instead, still only to
  // api.torn.com, and that choice is remembered. keyInQuery is also used if
  // Torn's v1 endpoint rejects the header (see stockMapFor).
  async function apiJSON(path, params, report = () => {}, { key, keyInQuery = false } = {}) {
    let viaAddress = keyInQuery || GM_getValue(KEY.queryMode, false) === true;
    let switched = false;
    let url;
    let headers;
    const build = () => {
      url = new URL(path, API);
      const query = new URLSearchParams({ ...params, comment: API_COMMENT });
      if (viaAddress) query.set('key', key);
      url.search = query.toString();
      headers = viaAddress ? {} : { Authorization: 'ApiKey ' + key };
    };
    build();
    for (let retry = 0; retry < 4; retry++) {""")
body = rep(body, """      } catch (error) {
        if (error instanceof Cancelled || activeAbort?.signal.aborted) throw new Cancelled();
        if (retry === 3)""", """      } catch (error) {
        if (error instanceof Cancelled || activeAbort?.signal.aborted) throw new Cancelled();
        // fetch() rejects with a TypeError when the browser blocks the request.
        if (!viaAddress && !switched && error?.name === 'TypeError') {
          viaAddress = true;
          switched = true;
          build();
          retry--;
          continue;
        }
        if (retry === 3)""")
body = rep(body, """      if (response.status < 200 || response.status >= 300 || !data) {
        throw new Error('Unexpected API response (HTTP ' + response.status + ').');
      }
      return data;""", """      if (response.status < 200 || response.status >= 300 || !data) {
        throw new Error('Unexpected API response (HTTP ' + response.status + ').');
      }
      if (switched) GM_setValue(KEY.queryMode, true);
      return data;""")

# 4. Page markup
body = rep(body, '<a class="back" href="/page.php?sid=stocks">Back to Stocks</a>',
           '<a class="back" href="https://www.torn.com/page.php?sid=stocks" target="_blank" rel="noopener noreferrer">Torn Stocks ↗</a>')
body = rep(body, '<input id="tsl-key" type="password" autocomplete="off" placeholder="Stored in Tampermonkey">',
           '<input id="tsl-key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your API key">\n'
           '          <label class="check" data-tip="Keep the key in this browser for next time. Untick to forget it when the page closes.">'
           '<input id="tsl-remember" type="checkbox"> Remember key</label>')
body = rep(body, '<span role="cell">Only locally (Tampermonkey / TornPDA storage on your device)</span>',
           '<span role="cell">Only locally (this browser\'s storage for this site; nothing is stored on a server)</span>')
body = re.sub(r'<b role="rowheader">Key Storage &amp; Sharing</b><span role="cell">[^<]*</span>',
              '<b role="rowheader">Key Storage &amp; Sharing</b><span role="cell">Stored only in this browser, and only while '
              '"Remember key" is ticked / Not shared. Used only for calls to api.torn.com, sent in the Authorization header '
              '(if your browser blocks that header, or Torn\'s older stock-names call rejects it, the key is sent in the '
              'request address instead, still only to api.torn.com)</span>', body)
body = rep(body, """          Backup saves a file to your device only, and never includes your key.
          <a href="https://www.torn.com/api.html" target="_blank" rel="noopener">Torn API</a></p>""",
"""          Backup saves a file to your device only, and never includes your key.
          This page is hosted on GitHub Pages: GitHub serves the page files, but your key and trades are never sent to GitHub
          (<a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener noreferrer">GitHub Privacy Statement</a>).
          <a href="https://www.torn.com/api.html" target="_blank" rel="noopener noreferrer">Torn API</a></p>""")

# 5. Page code: no TornPDA prefill, normal link for Torn Stocks, remember-key toggle
body = cut(body, "    // On TornPDA, offer the app's own key", "    fromInput.value =", """    const rememberBox = find('#tsl-remember');
    rememberBox.checked = rememberKey();
    rememberBox.addEventListener('change', () => {
      GM_setValue(KEY.remember, rememberBox.checked);
      GM_setValue(KEY.api, keyInput.value.trim());
      setStatus(rememberBox.checked ? 'Your API key will be remembered in this browser.' :
        'Your API key is no longer stored. It will be forgotten when you close this page.');
    });
""")
body = cut(body, "    find('.back').addEventListener('click'", "    // Show already cached trades", "", )
body = cut(body, "    if (!GM_getValue(KEY.api, '') && keyInput.value) {", "    page.appendChild(tip);", "")
body = body.replace('another Torn tab', 'another tab')

# 6. Mount into the page instead of Torn's stock app
body = cut(body, "  // Adds the ledger link next to TornTools", "})();", """  function start() {
    migrateCache();
    document.getElementById('app').replaceChildren(makePage());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
""")
for leftover in ['GM_addStyle', 'GM_xmlhttpRequest', 'PDA_', 'STOCKS_URL', 'LEDGER_URL', 'location.']:
    assert leftover not in body, leftover

header = f"""// Torn Stock Ledger (website) {version}
// Made by Eaglewing [571041] · https://github.com/Eaglewing91/torn-day-trader-logbook · MIT License
// Built from torn-day-trader-logbook.user.js. Runs entirely in your browser: the
// only network requests go to api.torn.com, and your key and trades are kept in
// this browser's storage. Nothing is sent to GitHub or anywhere else.
"""
open(ROOT + 'docs/app.js', 'w').write(header + body)

site_css = f"""/* Torn Stock Ledger (website) {version} · built from the userscript's styles */
:root{{color-scheme:dark}}
html{{background:#0a0809}}
body{{margin:0;min-height:100vh;background:radial-gradient(1200px 500px at 50% -200px,#3a141b,#0a0809 70%);
  color:#f6eef0;font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}}
#app{{max-width:1100px;margin:0 auto;padding:24px 16px 8px}}
#app>noscript{{display:block;padding:40px 20px;text-align:center;color:#b9a6aa}}
.site-footer{{max-width:1100px;margin:0 auto;padding:4px 16px 28px;color:#8d7b7f;font-size:11px;text-align:center}}
.site-footer a{{color:#d58b95}}
@media(max-width:600px){{#app{{padding:12px 8px 4px}}}}
"""
site_overrides = """
/* Website-only additions */
#tsl-page{margin:0}
#tsl-page .check{display:inline-flex;align-items:center;gap:6px;color:var(--text);font-size:12px;font-weight:600;cursor:pointer}
#tsl-page .check input{width:16px;height:16px;padding:0!important;margin:0;border:0!important;
  background:none!important;accent-color:var(--red);cursor:pointer}
"""
open(ROOT + 'docs/style.css', 'w').write(site_css + '\n'.join(l[4:] if l.startswith('    ') else l for l in css.strip('\n').split('\n')) + '\n' + site_overrides)
print('built site', version, len(body), 'chars')
