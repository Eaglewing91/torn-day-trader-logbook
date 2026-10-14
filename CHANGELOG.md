# Changelog

## 1.1.0 — 2026-10-14

### Now on Torn PDA
- Torn Stock Ledger is now available on **Torn PDA** as well as Tampermonkey in desktop browsers.

### New
- **Export CSV** — download the trades in the current view and filters (TCT dates, prices, fees, cost, proceeds, profit, manual-price and untracked-share flags).
- **Cancel** button to stop an import partway; everything fetched so far is kept.
- **Open positions** panel showing the shares and average cost still held at the end of the selected range.
- **"Sells missing buy price"** filter, plus a banner counting those sells with a "Show them" shortcut.
- Long lists show 100 trades at a time with a **Show more** button.

### Changed
- **All dates and times now use Torn City Time (UTC)**, including custom From/To ranges.
- Every view (not only Full History) now imports back to your account creation date, so each sell can be matched with its earlier buys. After the first run only new dates are fetched.
- **Profit maths:** a sell larger than your tracked holdings is split into tracked shares (at average cost) and untracked shares (which need a manual buy price). Previously the whole sell was either costed or left blank.
- Summary cards renamed to **Buy Cost / Sell Proceeds / Profit / Fees Paid**. They now count only sells with a known buy price, so cost and profit always cover the same trades. The trade count line shows "Bought in range".
- Manual buy prices have a visible **↺ Reset** button (previously a right-click).
- **Test Key** now checks that the key can read stock logs, not just your profile.
- Saving an empty API key field now deletes the stored key.
- Clearer messages for API errors 2, 10, 13, 16 and 18.
- The ledger link now appears without TornTools too, at the end of the Stocks page title.
- Cached trades show straight away on page load, with a note when earlier history is incomplete.

### Fixes and internals
- Import lock stops two Torn tabs from overwriting each other's cache.
- Trades and date coverage are saved together in batches, so an interrupted import never marks dates as checked without their trades. The last minute is always re-checked next time.
- Stock names refresh (at most hourly) when a trade references a stock the cache doesn't know.
- The trade cache stores only the fields it uses; older caches are shrunk once on upgrade.
- `@match` narrowed to the Stocks page, `@noframes` added, and the page observer now watches only the stock app.
- Terms of Service table and network-use note added to the script header.

### Data and API use
All network requests go to `api.torn.com` only. The CSV export is generated and downloaded locally. Your API key and trade cache stay in local script storage and are never shared.
