# GammaDesk

Options gamma levels, an OptionStrat-style strategy builder, a gamma-aware AI trade bot with backtesting, and a server-side paper-trading account. Starts with SPY; any CBOE-listed equity/ETF ticker works in the dashboard.

> Educational tool, not investment advice. Market data is 15-minute delayed; backtest and paper results are simulated.

## Run locally
Requires Node.js 20+ (no npm dependencies).
```
node server.js
```
Open http://localhost:5173.

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5173` | Port to listen on |
| `APP_PASSWORD` | _(none)_ | If set, every page and API call asks for this password (any username) |
| `DATA_DIR` | `./data` | Where the paper account and the bot's memory are stored |
| `PAPER` | _(on)_ | Set to `off` to disable the paper-trading bot |

## Deploy (Render)
1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint** and select the repo. `render.yaml` creates an always-on web service with a 1 GB disk for the paper account.
3. Enter an `APP_PASSWORD` when prompted, then share the `.onrender.com` link and the password.

The paper bot needs an always-on instance and a persistent disk (Render's paid Starter plan). On a free plan the service sleeps when idle, which pauses the bot, and restarts wipe the paper account.

## Tabs
- **Gamma Levels**: candlestick chart with toggleable Daily / Weekly / Monthly / Selected gamma levels, VWAP, VWAP bands and 2-day anchored VWAP; GEX by strike (net, call/put, absolute, volume, open interest); key-levels table; gamma profile; strike detail.
- **Strategy Builder**: 23 presets (incl. butterflies, broken-wing flies, flyagonals) or custom legs; payoff at any date / price / IV, greeks, P/L grid with spread prices, saved trades with notes.
- **AI Trade Bot**: confluence matrix, IV & pricing, intraday profile, strategy leaderboard, trade ideas per horizon with entry triggers and profit targets, paper journal, level memory.
- **Backtest**: replays the bot over the last month of real price / VWAP / VIX data (gamma levels use a stand-in, since historical open interest isn't freely available), plus a forward test on real gamma levels.
- **Paper Account**: the server-side bot trading $10,000 of paper money.

## Data
- Options chain: CBOE delayed quotes (~15 min), IV and open interest per contract.
- Candles: Yahoo Finance chart API (SPY and ^VIX).
The server proxies both (browsers can't call them directly) and caches for 60 s. These feeds are intended for personal use.

## Levels (per expiration set)
GEX per strike = gamma × OI × 100 × S² × 1%, calls positive / puts negative (dealers assumed long calls, short puts).
- **P1–P3**: most positive net GEX strikes. **N1–N3**: most negative.
- **Call Wall / Put Wall**: largest call gamma at/above spot, largest put gamma at/below spot.
- **Gamma Flip**: price where the total gamma profile crosses zero.
- **Max Pain**, **EM High/Low** (ATM straddle of the nearest expiration in the set).

## Bot
**Gamma is the main truth.** Gamma regime, distance to the flip and location vs the walls key the bot's learned memory, separately for Intraday (0–1 DTE), Weekly (~7 DTE) and Monthly (~30 DTE) horizons.

**Confluence** (`public/js/confluence.js`): 14 signals vote for bull / bear / range / move theses and sell / buy premium: gamma regime, spot vs flip, location vs walls, stacked D/W/M levels, session VWAP, 2-day anchored VWAP, VWAP vs AVWAP, VWAP ≈ gamma-level zones, IV vs realized vol, VIX 1-year rank, put skew, term structure, intraday character, and level memory. Default conviction rule: 6+ agreeing signals with a gamma veto (no trade the gamma regime argues against).

**Strategies** (`public/js/bot.js`): 19 templates built from the live levels, including 10 in the butterfly family (plain, iron, broken-wing, max-pain, and three flyagonals). A preference setting ranks the butterfly family higher.

**Exits**: profit target 50% for spreads and 20% for butterflies/flyagonals (after fees), stops at 2× credit or 50–60% of debit.

**Learning**: templates are scored on Monte Carlo paths with gamma-regime dynamics; outcomes update Beta posteriors per (horizon, context, strategy). Level memory scores what price actually did at each session's levels. Paper and backtest outcomes feed back with their own weights.

**Paper trader** (`trader.mjs`): trains at 9:35 ET, opens the top conviction pick per horizon from 10:00 ET, marks positions every 5 minutes on real chain mids, and settles at expiration. Max loss per trade 5% of equity, open risk ≤ 35%.

Add a new confluence signal by adding a block in `buildSignals()`.
