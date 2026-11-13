# GammaDesk

Options gamma levels, an OptionStrat-style strategy builder, a gamma-aware AI trade bot with backtesting, and a server-side paper-trading account. Starts with SPY; any CBOE-listed equity/ETF ticker works in the dashboard.

> Educational tool, not investment advice. Market data is 15-minute delayed unless Schwab is connected; backtest and paper results are simulated.

## Run locally
Requires Node.js 20+ (no npm dependencies).
```
node server.js
```
Open http://localhost:5173.

Optional settings (environment variables, or a `.env` file next to `server.js`; see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5173` | Port to listen on |
| `APP_PASSWORD` | _(none)_ | If set, every page and API call asks for this password (any username) |
| `DATA_DIR` | `./data` | Where the paper account and the bot's memory are stored |
| `PAPER` | _(on)_ | Set to `off` to disable the paper-trading bot |
| `ARCHIVE` | _(on)_ | Set to `off` to stop saving daily option chains and bars (see Archive) |
| `DATA_PROVIDER` | `auto` | `auto` (Schwab when signed in, else CBOE), `schwab`, or `cboe` |
| `SCHWAB_APP_KEY` / `SCHWAB_APP_SECRET` / `SCHWAB_CALLBACK` | _(none)_ | Schwab developer app credentials (see below) |

## Real-time data (Schwab)
By default options chains come from CBOE's free feed (about 15 minutes delayed). With a Schwab account you can switch to real-time chains through the Schwab Trader API (the same data thinkorswim shows):
1. At developer.schwab.com, create an app with the **Market Data** product and a callback URL (e.g. `https://127.0.0.1`). Approval takes a few business days.
2. Copy `.env.example` to `.env` and fill in `SCHWAB_APP_KEY`, `SCHWAB_APP_SECRET` and `SCHWAB_CALLBACK` (exactly as registered). `.env` is git-ignored.
3. Restart the server, click **Data** in the header, sign in to Schwab, and paste the address Schwab redirects you to.

The server refreshes the 30-minute access token automatically. Schwab requires signing in again every 7 days; the header badge warns 24 hours ahead, and the app falls back to CBOE whenever Schwab isn't connected or a request fails. Sign-in tokens are stored in `DATA_DIR/schwab-tokens.json`. With real-time data the paper trader checks positions every 2 minutes instead of 5. `/ES` levels are still SPX levels plus the ES–SPX basis (Schwab's API doesn't provide futures options chains).

## Deploy (Render)
1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint** and select the repo. `render.yaml` creates an always-on web service with a 1 GB disk for the paper account.
3. Enter an `APP_PASSWORD` when prompted, then share the `.onrender.com` link and the password.

The paper bot needs an always-on instance and a persistent disk (Render's paid Starter plan). On a free plan the service sleeps when idle, which pauses the bot, and restarts wipe the paper account.

## Tabs
- **Gamma Levels**: candlestick chart with toggleable Daily / Weekly / Monthly / Selected gamma levels, VWAP, VWAP bands and 2-day anchored VWAP; GEX by strike (net, call/put, absolute, volume, open interest); key-levels table; gamma profile; strike detail.
- **Strategy Builder**: 23 presets (incl. butterflies, broken-wing flies, flyagonals) or custom legs; payoff at any date / price / IV, greeks, P/L grid with spread prices, saved trades with notes.
- **AI Trade Bot**: confluence matrix, IV & pricing, intraday profile, strategy leaderboard, trade ideas per horizon with entry triggers and profit targets, paper journal, level memory.
- **Backtest (proxy)**: replays the bot over the last month of real price / VWAP / VIX data. **It is not a test of the gamma thesis**: historical open interest isn't freely available, so the gamma levels are a 20-day-average stand-in. It reports win rate next to the break-even win rate, average win/loss, return on risk, profit factor, max drawdown and largest loss. A forward test on real gamma levels is at the bottom.
- **Paper Account**: the server-side bot trading $10,000 of paper money.

## Data
- Options chain: CBOE delayed quotes (~15 min), IV and open interest per contract.
- Candles: Yahoo Finance chart API (SPY, SPX, QQQ, ES=F and ^VIX).
The server proxies both (browsers can't call them directly) and caches for 60 s. These feeds are intended for personal use.

## Levels (per expiration set)
GEX per strike = gamma × OI × 100 × S² × 1%, calls positive / puts negative (dealers assumed long calls, short puts).
- **P1–P3**: most positive net GEX strikes. **N1–N3**: most negative.
- **Call Wall / Put Wall**: largest call gamma at/above spot, largest put gamma at/below spot.
- **Gamma Flip**: price where the total gamma profile crosses zero.
- **Max Pain**, **EM High/Low** (ATM straddle of the nearest expiration in the set).

## Bot
**Gamma is the main truth.** Gamma regime, distance to the flip and location vs the walls key the bot's learned memory, separately for Intraday (0–1 DTE), Weekly (~7 DTE) and Monthly (~30 DTE) horizons.

**Confluence** (`public/js/confluence.js`): 17 signals vote for bull / bear / range / move theses and sell / buy premium: gamma regime, spot vs flip, location vs walls, stacked D/W/M levels, SPX gamma (regime and location, mapped to SPY), QQQ gamma, session VWAP, 2-day anchored VWAP, VWAP vs AVWAP, VWAP ≈ gamma-level zones, IV vs realized vol, VIX 1-year rank, put skew, term structure, intraday character, and level memory. Default conviction rule: 6+ agreeing signals with a gamma veto (no trade the gamma regime argues against).

**Strategies** (`public/js/bot.js`): 19 templates built from the live levels, including 10 in the butterfly family (plain, iron, broken-wing, max-pain, and three flyagonals). A preference setting ranks the butterfly family higher.

**Exits**: profit target 50% for spreads and 20% for butterflies/flyagonals (after fees), stops at 2× credit or 50–60% of debit.

**Learning**: templates are scored on Monte Carlo paths with gamma-regime dynamics; outcomes update Beta posteriors per (horizon, context, strategy). Level memory scores what price actually did at each session's levels. Paper and backtest outcomes feed back with their own weights.

**Paper trader** (`trader.mjs`): trains at 9:35 ET, opens the top conviction pick per horizon from 10:00 ET, marks positions every 5 minutes (2 on real-time data) on real chain mids, and settles at expiration. Max loss per trade 5% of equity, open risk ≤ 35%. Intraday (0DTE) entries only happen on real-time Schwab data; on 15-minute-delayed quotes the bot trades weekly and monthly only.

**Known limits.** The Monte Carlo simulator encodes the gamma thesis (positive gamma pins, negative gamma trends), so what the bot learns from simulation reflects those assumptions. The dealer-positioning assumption behind GEX (dealers long calls, short puts) is a convention, not an observed fact. Treat results as unproven until the real-gamma backtest and a sample of 100+ paper trades say otherwise.

## Archive
On every trading day the server saves the full SPY, SPX and QQQ option chains (with the computed gamma levels) at 10:00, 12:30 and 15:45 ET, and the day's 1-minute and 5-minute bars for SPY, SPX, QQQ, VIX and /ES at 16:20 ET, to `DATA_DIR/archive/YYYY-MM-DD/` (gzipped JSON, about 3–5 MB a day). After a few weeks this is the data for a backtest on real gamma levels. Progress shows in the Backtest tab and at `/api/archive`. The server must be running at those times; a missed snapshot is taken up to 90 minutes late.

Add a new confluence signal by adding a block in `buildSignals()`.
