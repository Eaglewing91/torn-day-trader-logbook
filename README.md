# Torn Stock Ledger

**Stock trade history and profit tracking for Torn**  
Version **1.0.0** · Created by **Eaglewing [571041]**

Torn Stock Ledger is the newly developed, fully working release of **Torn Day Trader Logbook (Experimental)**. It gives your stock trades a dedicated page within Torn, with a clear view of buying costs, selling fees and profit.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. **[Install Torn Stock Ledger](https://raw.githubusercontent.com/Eaglewing91/torn-day-trader-logbook/main/torn-day-trader-logbook.user.js)** and confirm the installation in Tampermonkey.
3. Open [Torn's Stocks page](https://www.torn.com/page.php?sid=stocks). Click **Torn Stock Ledger** next to the stock value and profit figures.

> **Upgrading?** Disable older Day Trader Logbook or Full History Test scripts in Tampermonkey to avoid their floating panels. If you installed an earlier copy of **1.0.0** with a broken update link, reinstall it once using the link above.

## What it does

- Displays BUY and SELL trades on a dedicated Torn URL, with no floating panel.
- Loads the last **7, 14 or 30 days**, a **From / To** date range, or **Full History**.
- Shows a progress bar while importing full history, starting from your account creation date.
- Displays buy and sell prices, shares, gross sale, the **0.10% sell fee**, and profit for each trade.
- Calculates costs using the average cost of shares held; you can enter a buy price for an older sale when its cost is unknown.
- Lets you select a stock and filter the visible rows to buys or sells.
- Summarizes the cost basis, proceeds, fees and profit of sales in the selected dates and stock. The BUY/SELL row filter does not change these totals.
- Caches imported trades locally so they can be displayed again without a full import.

## Getting started

1. Enter a **Full Access Torn API key** on the ledger page. You can use **Test Key** to check it.
2. Choose **7D**, **14D**, **30D**, or both **From** and **To** dates. Choose **Full History** to retrieve all available account history with one click.
3. Select a trade to see its full breakdown. Use **Pull Now** to refresh the selected range.

The first Full History import may take a minute or two. Its progress bar tracks the account dates checked. If an import stops, completed data remains cached and you can click **Full History** again to continue.

## Data and accuracy

Your API key and trade cache are stored locally in Tampermonkey. The key is sent to Torn's API to request your data. Torn's rounding may cause small differences between displayed calculations and settled amounts. A sale with no known buy cost shows no calculated profit until you enter a manual buy price.

## Updates

The install link points to `torn-day-trader-logbook.user.js`, the existing filename in this repository. The script's update URLs point to the same file. Future releases can update installed copies when their script version is increased.

## License

[MIT License](LICENSE)
