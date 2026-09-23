# Torn Stock Ledger

**Version 1.0.0** · **Eaglewing [571041]**

Torn Stock Ledger is the newly developed, fully working release of **Torn Day Trader Logbook (Experimental)**. It displays your Torn stock BUY and SELL history, costs, fees and profit on its own page within Torn.

## Features

- A **Torn Stock Ledger** link beside the value and profit figures on Torn's Stocks page; the ledger opens on a dedicated URL, without a floating panel.
- **7 / 14 / 30 day** views, **From / To** dates and a one-click **Full History** import from your account creation date. Full History shows progress and may take a minute or two to obtain all available data.
- A compact trade list showing **BUY/SELL, date, stock, shares, price and profit**. Select a row to see its buy and sell prices, gross sale, 0.10% sell fee and totals.
- **Per-stock tabs** and an **All / BUY / SELL** action filter.
- An **average-cost ledger** for merged stock positions, with a manual buy-price option when an older SELL has no known cost basis.
- Summary figures for total buy cost, total sell proceeds, profit and fees for the selected date range and stock tab.
- Locally cached trade history in Tampermonkey, plus controls to test your API key, refresh trades and clear cached data.

## Install

1. Install **Tampermonkey** for your browser.
2. [Install Torn Stock Ledger](https://raw.githubusercontent.com/Eaglewing91/torn-day-trader-logbook/main/torn-stock-ledger.user.js).
3. If you previously used **Torn Day Trader Logbook (Experimental)** or a **Full History Test** script, disable those older scripts in Tampermonkey. They have their own floating panels.

## Usage

1. Open [Torn's Stocks page](https://www.torn.com/page.php?sid=stocks) and select **Torn Stock Ledger** beside the profit figure.
2. Enter your **Full Access Torn API key**. Use **Test Key** if you want to check it.
3. Select **7D**, **14D**, **30D**, set both **From** and **To**, or select **Full History**. The date controls load trades when a key is available; **Pull Now** refreshes the selected range.
4. Use the stock tabs and action filter to inspect trades. Select a trade to expand its details.

Full History starts with one click, checks your account creation date and retrieves the available stock logs. The first import may take a minute or two. Imported trades are cached locally so the ledger can display them again without repeating the full import.

## Data and accuracy

- Your API key and cached trades are stored in Tampermonkey on your device. The key is sent to Torn's API when the script requests data.
- Torn charges a **0.10% sell fee**. Small differences can occur because of rounding.
- Profit and the summary figures are calculated from completed SELL trades in the selected date range and stock tab. The BUY/SELL action filter changes which rows are shown; it does not change those summary figures.
- Older SELL trades may have an unknown cost basis until you enter a manual buy price.

## Updates

This release is **1.0.0**. Install from the GitHub link above to receive future Tampermonkey updates when the version in `torn-stock-ledger.user.js` is increased.

## License

MIT — see [LICENSE](LICENSE).
