# Polymarket BTC Assistant

A terminal-first Paper and guarded Live trading engine for Polymarket
**"Bitcoin Up or Down" 15-minute** markets.

It combines Polymarket market data and executable order-book depth, the official
Chainlink BTC/USD 60-second TWAP reference, Binance spot data, and short-term
technical indicators. The same guarded strategy powers both realistic Paper
simulation and official-SDK Live FOK orders.

Key capabilities:

- Exact market-start TWAP validation with fail-closed reference states.
- Heiken Ashi, RSI, MACD, VWAP, regime, and short-term momentum signals.
- Paper execution with book walking, dynamic fees, slippage, and settlement.
- Guarded Live trading that starts stopped and requires `A`, then `Enter`.
- Combined terminal mode or a detachable Dashboard over a local Unix socket.
- Stale WebSocket detection, forced stream recovery, and runtime health display.
- A unified `poly` CLI and Paper-first systemd deployment for 24x7 Linux use.

Live trading can lose money. It never falls back to Paper, never persists the
Armed state, and fails closed when reference data, credentials, account checks,
or execution constraints are invalid.

## Requirements

- Node.js **24+** (required by the official `@polymarket/client` SDK)
- npm (comes with Node)


## Run from terminal (step-by-step)

### 1) Clone the repository

```bash
git clone https://github.com/boycez/polymarket-btc-assistant.git
```

Alternative (no git):

- Click the green `<> Code` button on GitHub
- Choose `Download ZIP`
- Extract the ZIP
- Open a terminal in the extracted project folder

Then open a terminal in the project folder.

### 2) Install dependencies

```bash
npm install
npm link
```

`npm link` registers the repository's `poly` command for the current Node.js
installation. The existing npm scripts remain available as fallback entry
points.

### 3) Start Paper mode

```bash
poly start paper
```

Paper is the default, so `poly start` is equivalent. Press `Ctrl+C` to stop.
Use `poly --help` to see the combined, Dashboard, diagnostics, and systemd
commands.

### 4) (Optional) Set environment variables

You can run without extra config (defaults are included), but for more stable Chainlink fallback it’s recommended to set at least one Polygon RPC.

#### Windows PowerShell (current terminal session)

```powershell
$env:POLYGON_RPC_URL = "https://polygon-rpc.com"
$env:POLYGON_RPC_URLS = "https://polygon-rpc.com,https://rpc.ankr.com/polygon"
$env:POLYGON_WSS_URLS = "wss://polygon-bor-rpc.publicnode.com"
```

Optional Polymarket settings:

```powershell
$env:POLYMARKET_AUTO_SELECT_LATEST = "true"
# $env:POLYMARKET_SLUG = "btc-updown-15m-..."   # pin a specific market
```

#### Windows CMD (current terminal session)

```cmd
set POLYGON_RPC_URL=https://polygon-rpc.com
set POLYGON_RPC_URLS=https://polygon-rpc.com,https://rpc.ankr.com/polygon
set POLYGON_WSS_URLS=wss://polygon-bor-rpc.publicnode.com
```

Optional Polymarket settings:

```cmd
set POLYMARKET_AUTO_SELECT_LATEST=true
REM set POLYMARKET_SLUG=btc-updown-15m-...
```

Notes:
- These environment variables apply only to the current terminal window.
- If you want permanent env vars, set them via Windows System Environment Variables or use a `.env` loader of your choice.

## Configuration

This project reads configuration from environment variables.

You can set them in your shell, or create a `.env` file and load it using your preferred method.

### Polymarket

- `POLYMARKET_AUTO_SELECT_LATEST` (default: `true`)
  - When `true`, automatically picks the latest 15m market.
- `POLYMARKET_SERIES_ID` (default: `10192`)
- `POLYMARKET_SERIES_SLUG` (default: `btc-up-or-down-15m`)
- `POLYMARKET_SLUG` (optional)
  - If set, the assistant will target a specific market slug.
- `POLYMARKET_LIVE_WS_URL` (default: `wss://ws-live-data.polymarket.com`)
- `POLYMARKET_DUMP_MARKET_SNAPSHOTS` (default: `false`)
  - When enabled, writes one full Gamma market JSON snapshot per market to
    `logs/polymarket_market_<slug>.json` for debugging.

### Chainlink on Polygon (fallback)

- `CHAINLINK_BTC_USD_AGGREGATOR`
  - Default: `0xc907E116054Ad103354f2D350FD2514433D57F6f`

HTTP RPC:
- `POLYGON_RPC_URL` (default: `https://polygon-rpc.com`)
- `POLYGON_RPC_URLS` (optional, comma-separated)
  - Example: `https://polygon-rpc.com,https://rpc.ankr.com/polygon`

WSS RPC (optional but recommended for more real-time fallback):
- `POLYGON_WSS_URL` (optional)
- `POLYGON_WSS_URLS` (optional, comma-separated)

### Official 15-minute market reference

The assistant subscribes to Polymarket RTDS `crypto_prices_twap_sixty` for
Chainlink `btc/usd` 60-second TWAP updates. A market is allowed to trade only
when an update's Chainlink observation timestamp exactly matches that market's
`eventStartTime`. The exact E18 value is persisted in:

```text
logs/market_references.csv
```

Reference states are fail-closed:

- `ARMED`: connected before the next market starts; trading is closed.
- `SYNCING`: waiting briefly for the exact start observation; trading is closed.
- `READY`: exact start TWAP is validated and current TWAP is fresh; trading is open.
- `MISSED_WINDOW`: the exact start observation is not available; trading remains
  closed unless the official stream later delivers that exact timestamp.
- `DEGRADED`: the stream is disconnected, stale, or incompatible; trading is closed.

Starting the process in the middle of a market normally produces
`MISSED_WINDOW`. Keep it running until the next 15-minute boundary. A delayed
official sample can restore `READY` only when its observation timestamp exactly
matches the market start; nearby or current prices are never substituted. A
restart can also restore `READY` when the current market already has a valid
persisted reference record.

Optional environment variables:

- `MARKET_REFERENCE_FILE` (default: `./logs/market_references.csv`)
- `TWAP_CAPTURE_GRACE_MS` (default: `5000`)
- `TWAP_FRESHNESS_MS` (default: `5000`)

### Proxy support

The bot supports HTTP(S) proxies for both HTTP requests (fetch) and WebSocket connections.

Supported env vars (standard):

- `HTTPS_PROXY` / `https_proxy`
- `HTTP_PROXY` / `http_proxy`
- `ALL_PROXY` / `all_proxy`

Examples:

PowerShell:

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:8080"
# or
$env:ALL_PROXY = "socks5://127.0.0.1:1080"
```

CMD:

```cmd
set HTTPS_PROXY=http://127.0.0.1:8080
REM or
set ALL_PROXY=socks5://127.0.0.1:1080
```

#### Proxy with username + password (simple guide)

1) Take your proxy host and port (example: `1.2.3.4:8080`).

2) Add your login and password in the URL:

- HTTP/HTTPS proxy:
  - `http://USERNAME:PASSWORD@HOST:PORT`
- SOCKS5 proxy:
  - `socks5://USERNAME:PASSWORD@HOST:PORT`

3) Set it in the terminal and run the bot.

PowerShell:

```powershell
$env:HTTPS_PROXY = "http://USERNAME:PASSWORD@HOST:PORT"
poly start paper
```

CMD:

```cmd
set HTTPS_PROXY=http://USERNAME:PASSWORD@HOST:PORT
poly start paper
```

Important: if your password contains special characters like `@` or `:` you must URL-encode it.

Example:

- password: `p@ss:word`
- encoded: `p%40ss%3Aword`
- proxy URL: `http://user:p%40ss%3Aword@1.2.3.4:8080`

## Operating modes

Paper trading is the default mode:

```bash
poly start
```

Select the combined terminal mode explicitly with:

```bash
poly start paper
poly start live
```

The npm script aliases remain available:

```bash
npm run paper
npm run live
```

On macOS or Linux, the trading engine can also run headlessly without owning a
terminal dashboard:

```bash
npm run engine -- paper
npm run engine -- live
```

The headless Engine runs the same market, strategy, logging, and Paper/Live
trading loop as combined mode. Each runtime snapshot is published as
newline-delimited JSON over an owner-only (`0600`) local Unix socket. The
default path is:

```text
/tmp/polymarket-btc-assistant-<uid>.sock
```

Set `POLYMARKET_ENGINE_SOCKET` to use a different local socket path. Starting a
second Engine against an active socket fails instead of replacing the running
Engine. Closing an attached client does not stop the Engine. Live mode remains
stopped after every startup.

Attach the terminal Dashboard from a second terminal:

```bash
poly dashboard
```

The Dashboard immediately receives the Engine's latest cached snapshot, shows
the Engine connection state and snapshot age, and reconnects automatically if
the Engine restarts. Pressing `Ctrl+C` detaches only the Dashboard; the Engine
continues running. The transport is a local Unix socket, not a browser or TCP
service, and snapshots with malformed JSON or unsupported protocol versions are
ignored.

In Live mode, the permission-restricted socket accepts a strict versioned control protocol.
The Dashboard preserves the same two-step safety flow as combined mode:

- Press `A` to request arming, then `Enter` to confirm.
- Press `Esc` to cancel a pending arming request.
- Press `S` to stop new orders and cancel all open CLOB orders.
- Press `X` to cancel open CLOB orders without changing the arm state.

Paper mode rejects all control commands. Unknown actions, malformed commands,
oversized frames, and unsupported protocol versions fail closed. Control errors
return generic messages and never include signer or Relayer credentials.

For local development, combined mode remains available and does not require a
second terminal:

```bash
poly start paper
poly start live
```

## Stream health and systemd

The Engine monitors Binance, Polymarket current-price, Chainlink fallback, and
official Polymarket TWAP WebSocket health. A connected stream that stops
delivering valid data is marked stale and force-reconnected with a cooldown;
the Dashboard shows the aggregate health in `Data Streams`.

Optional watchdog settings:

- `STREAM_HEALTH_CHECK_MS` (default: `5000`)
- `STREAM_RESTART_COOLDOWN_MS` (default: `15000`)
- `BINANCE_STREAM_STALE_MS` (default: `30000`)
- `POLYMARKET_LIVE_STREAM_STALE_MS` (default: `15000`)
- `TWAP_STREAM_STALE_MS` (default: `15000`)

An Azure Linux VM systemd template and Paper-first installation guide are in
[`deploy/systemd/`](deploy/systemd/README.md). It runs under a dedicated
unprivileged account, uses a trusted-group local socket, writes process output
to journald, restarts after failures, and performs graceful shutdown. After
installation, daily operations are:

```bash
poly engine start
poly engine stop
poly engine restart
poly engine status
poly engine logs
poly dashboard
poly doctor
```

The deployment does not configure SSH or unattended Live credentials. The
systemd template remains Paper-only.

You can also select a mode with `TRADING_MODE=paper|live` or
`node src/index.js --mode=paper|live`. A CLI argument takes precedence over the
environment variable.

Live trading uses the official `@polymarket/client` SDK. `poly start live` never
falls back to paper trading. It authenticates and runs startup checks, but order
submission remains stopped until the user manually enables it after startup.

The two modes use isolated fact logs:

```text
logs/paper_trades.csv
logs/live_trades.csv
```

`PAPER_TRADE_FILE` can override the Paper path. The Live fact log is fixed at
`logs/live_trades.csv` so its audit location cannot be changed by user trading
configuration. It contains actual SDK order IDs, exchange status, filled
collateral and shares, plus rejected or ambiguous attempts. Never treat the
signal log as proof of an exchange fill.

## Live trading

Use a dedicated, minimally funded Polymarket signer. Never commit or paste its
private key or Relayer API key into source files, chat, shell history,
screenshots, environment variables, or logs. In local Live mode, the program
requests both directly from the interactive terminal with input echo disabled.
They are kept only in process memory for the lifetime of that run.

Non-secret local settings are read from:

```text
config/live.local.json
```

This file is ignored by Git and must not contain a private key. Start from the
tracked `config/live.example.json` template. Set `LIVE_CONFIG_FILE` to use a
different path. Environment variables override values from the JSON file, which
in turn override the built-in conservative defaults.

Set `walletAddress` to the public Trading/Proxy Wallet address shown by your
existing Polymarket account. This is required for email, Google, and Apple
accounts: their exported private key identifies the signer, while balances and
positions belong to a separate account wallet. Passing that existing wallet to
the SDK avoids accidentally creating a new Deposit Wallet. Live startup still
requires a Relayer API key associated with the signer.

The local file contains only user-controlled stake, session, and runtime
settings. Signal confirmation, entry timing, minimum edge, slippage, and trend
alignment belong to the versioned strategy in
`src/trading/strategy.js`; they are shared by Paper and Live and cannot be
changed from the local config.

Live startup displays this prompt before opening the dashboard:

```text
Polymarket signer private key (hidden):
Polymarket Relayer API key (hidden):
```

Paste or type a `0x`-prefixed 32-byte private key and press `Enter`. No key
characters are displayed. Press `Esc` or `Ctrl+C` to cancel. Non-interactive
stdin fails closed because it cannot securely request the key.

Create the Relayer API key under `polymarket.com → Settings → API Keys →
Relayer API Keys`. The Signer Address shown there must match the address derived
from the private key. The program derives that address automatically when it
builds the Relayer authorization; a mismatch between signer and account wallet
is rejected before authentication.

The terminal shows the SDK-confirmed `client.account.wallet` and wallet type in
masked form so the actual execution account can be verified before automatic
orders are enabled.

Start Live authentication and preflight with:

```bash
poly start live
```

After the checks pass, verify the masked trading wallet and wallet type. The
automatic-order control still starts as `Stopped`; do not press `A` until the
displayed account identity and collateral balance are the ones you expect.

Before an armed process opens market streams, it fails closed unless all startup
checks pass:

- The official Polymarket geoblock endpoint reports that trading is allowed.
- The account is not in closed-only mode.
- The collateral balance covers the configured stake.
- The stake is positive and does not exceed the hard maximum.
- The per-process trade limit is a positive integer.

After startup, Live Trading always begins in `Stopped` state. In an interactive
terminal:

- Press `A` to request enabling automatic orders.
- Review the displayed stake, session limit, slippage cap, and stop action.
- Press `Enter` to confirm, or `Esc` to cancel and remain stopped.
- Press `S` at any time to stop new orders and call `cancelAll()` for open CLOB
  orders.
- Press `Ctrl+C` to stop, cancel open orders, and exit.

The enabled state is never persisted across restarts. A combined Live process
requires an interactive TTY for controls. A headless Live Engine has no local
keyboard controls and remains stopped until an authorized terminal Dashboard
completes `A` then `Enter`. Stopping does not sell or otherwise close positions
that have already filled; those positions continue to settlement.

For a new wallet, run once with `LIVE_TRADING_SETUP_APPROVALS=true`. This calls
the SDK's on-chain/gasless trading approval workflow during startup. Review the
wallet and amount first, then return the setting to `false` for normal runs.

Live entries preserve the paper strategy gates: exact reference TWAP readiness,
5-10 minutes remaining, 30-second signal confirmation, trend
alignment, minimum executable edge, full local book depth, tick size, minimum
order size, and maximum slippage. The actual request is an immediate FOK buy
with `maxSpend` equal to the all-in stake. A market is locked after any submission
attempt so an ambiguous timeout cannot cause a duplicate order.

Safety settings:

- `LIVE_TRADE_STAKE_USD` (default: `5`)
- `LIVE_TRADE_MAX_TRADES_PER_SESSION` (default: `1`)
- `LIVE_TRADING_CANCEL_ON_EXIT` (default: `true`)
- `LIVE_TRADING_SETUP_APPROVALS` (default: `false`)
- `LIVE_TRADE_SETTLEMENT_POLL_MS` (default: `30000`)

`LIVE_TRADE_HARD_MAX_STAKE_USD` is a deployment-level hard cap (default: `10`).
It is intentionally unavailable in `live.local.json`. A configured stake above
this cap causes startup to fail instead of being silently reduced.

With cancel-on-exit enabled, `SIGINT` and `SIGTERM` call the official SDK's
`cancelAll()` before exit. FOK entries should never rest, but this provides an
account-wide kill switch for any open CLOB orders. A forced `SIGKILL`, machine
failure, or network outage cannot run this handler; account monitoring remains
necessary for real funds.

## Paper trading

Paper trading is enabled by default. The `TA_EDGE_V1_2_FOK` strategy records at
most one simulated trade for a market when all of these conditions remain true
for 30 seconds:

- The market has between 5 and 10 minutes remaining.
- The recommendation is `BUY UP` or `BUY DOWN`.
- The detected regime agrees with the direction (`TREND_UP` or `TREND_DOWN`).
- The model probability exceeds the fee-adjusted executable price by at least
  10%.
- The market is active, open, accepting orders, and has an enabled order book.
- The full all-in stake can execute within 2 cents of the best ask.

Execution simulates a Fill or Kill (FOK) taker order. It walks every available
ask level up to the limit price, enforces the live CLOB tick size and minimum
order size, rounds shares down to two decimals, and rejects the entire trade if
the requested stake cannot fill. When fees are enabled, it applies the market's
fee schedule using Polymarket's taker fee formula and five-decimal fee rounding.

Trades are recorded in:

```text
logs/paper_trades.csv
```

The default all-in stake is $10. The CSV records best ask, limit price, average
fill price, worst fill price, slippage, notional, fee, shares, and net execution
edge. After the market end time, the assistant polls the Polymarket Gamma API
until the market is officially resolved. It then records the winning outcome,
payout, fee-adjusted PnL, and an explicit `result` of `WIN` or `LOSE` in the same
CSV file. Unsettled trades use `result=PENDING`. Keep or restart the assistant to
allow awaiting trades to be settled.

The `Paper Trade` line on the console shows one of these states:

- `waiting: model probability below 60.0%`
- `waiting: outside entry window (12.0m remaining)`
- `waiting: UP requires TREND_UP`
- `waiting: execution edge 7.2% < 10.0%`
- `UP confirming 18/30s`
- `UP AWAITING_SETTLEMENT @ 42.0c`
- `UP SETTLED (+$13.81)`

The same specific gate reasons are used in Live mode. For later threshold
analysis, each distinct gate category is recorded once per market and mode in:

```text
logs/strategy_gate_events.csv
```

This log includes the model probabilities, normalized market probabilities,
quoted edges, regime, remaining time, recommendation, and final gate reason. It
does not change the strategy or record credentials.

The separate `Paper Trading` console section also shows total, settled and
awaiting trades, wins and losses, win rate, realized PnL, realized return, and
pending stake.

Optional environment variables:

- `PAPER_TRADE_STRATEGY` (default: `TA_EDGE_V1_2_FOK`)
- `PAPER_TRADE_CONFIRMATION_SECONDS` (default: `30`)
- `PAPER_TRADE_MIN_REMAINING_MINUTES` (default: `5`)
- `PAPER_TRADE_MAX_REMAINING_MINUTES` (default: `10`)
- `PAPER_TRADE_MIN_EXECUTION_EDGE` (default: `0.1`)
- `PAPER_TRADE_MAX_SLIPPAGE` (default: `0.02`)
- `PAPER_TRADE_REQUIRE_TREND_ALIGNMENT` (default: `true`)
- `PAPER_TRADE_STAKE_USD` (default: `10`)
- `PAPER_TRADE_SETTLEMENT_POLL_MS` (default: `30000`)
- `PAPER_TRADE_FILE` (default: `./logs/paper_trades.csv`)

Strategy overrides are parsed at startup. Invalid numbers, malformed booleans,
an inverted remaining-time window, or edge/slippage values outside `0` to `1`
cause startup to fail instead of silently changing trading behavior.

Each paper trade also records its strategy, execution details, confirmation
duration, remaining time, and detected regime for later analysis. The simulator
cannot validate wallet balance, token allowance, API authentication, account
restrictions, or network/signing failures because it never connects a wallet or
places a real order.

Run the local behavior tests with:

```bash
npm test
```

### Stop

Press `Ctrl + C` in the terminal.

### Update to latest version

```bash
git pull
npm install
npm link
poly start paper
```

## Notes / Troubleshooting

- If you see no Chainlink updates:
  - Polymarket WS might be temporarily unavailable. The bot falls back to Chainlink on-chain price via Polygon RPC.
  - Ensure at least one working Polygon RPC URL is configured.
- If the console looks like it “spams” lines:
  - The renderer uses `readline.cursorTo` + `clearScreenDown` for a stable, static screen, but some terminals may still behave differently.

## Safety

This is not financial advice. Use at your own risk.

created by @krajekis
