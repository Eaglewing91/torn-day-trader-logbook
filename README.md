# Torn Day Trader Logbook (Experimental)

A draggable in-game panel for **Torn** that shows your stock trade history (BUY/SELL logs) and calculates profit/loss per transaction using your own API data.

## Features

- Pull trade logs for **7 / 14 / 30 days** or a **custom date range**
- Per-trade columns: Buy Price, Sell Price, Shares, Gross (Sell), Fee (0.10%), Total Buy, Total Sell, Profit
- **Average-cost ledger** (matches Torn’s merged-position behaviour)
- **Per-stock tabs** (ALL / ELT / TCI / …) so you can review trades stock-by-stock
- Inline **manual BUY price** override for old SELL rows where the cost basis can’t be resolved
- All data is stored **locally** in your browser (Tampermonkey storage). Your API key is never shared.

## Install

1. Install **Tampermonkey** (Chrome / Edge / Firefox)
2. Install the userscript from GitHub raw:
   - `torn-day-trader-logbook.user.js`

## Usage

1. Open Torn Stocks page: `https://www.torn.com/page.php?sid=stocks`
2. Click **Day Trader Logbook** (launcher button) if the panel isn’t already open
3. Paste your **Full Access API key** (stored locally)
4. Select a range (7D/14D/30D) or choose From/To dates
5. Click **Pull Now**
6. Use the **tabs** to switch between **ALL** trades or a single stock ticker

## Notes on accuracy

- Torn applies a **0.10% sell fee** and rounds in ways that can create tiny differences.
- This script is designed to closely match Torn’s settlement maths; very small rounding differences can still occur.

## License

MIT — see `LICENSE`.
