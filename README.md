# Polymarket BTC 15m Assistant

A real-time console trading assistant for Polymarket **"Bitcoin Up or Down" 15-minute** markets.

It combines:
- Polymarket market selection + UP/DOWN prices + liquidity
- Polymarket live WS **Chainlink BTC/USD CURRENT PRICE** (same feed shown on the Polymarket UI)
- Fallback to on-chain Chainlink (Polygon) via HTTP/WSS RPC
- Binance spot price for reference
- Short-term TA snapshot (Heiken Ashi, RSI, MACD, VWAP, Delta 1/3m)
- A simple live **Predict (LONG/SHORT %)** derived from the assistant’s current TA scoring

## Requirements

- Node.js **18+** (https://nodejs.org/en)
- npm (comes with Node)


## Run from terminal (step-by-step)

### 1) Clone the repository

```bash
git clone https://github.com/FrondEnt/PolymarketBTC15mAssistant.git
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
```

### 3) (Optional) Set environment variables

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
npm start
```

CMD:

```cmd
set HTTPS_PROXY=http://USERNAME:PASSWORD@HOST:PORT
npm start
```

Important: if your password contains special characters like `@` or `:` you must URL-encode it.

Example:

- password: `p@ss:word`
- encoded: `p%40ss%3Aword`
- proxy URL: `http://user:p%40ss%3Aword@1.2.3.4:8080`

## Run

```bash
npm start
```

## Paper trading

Paper trading is enabled by default. The `TA_EDGE_V1_1` strategy records at
most one simulated trade for a market when all of these conditions remain true
for 30 seconds:

- The market has between 5 and 10 minutes remaining.
- The recommendation is `BUY UP` or `BUY DOWN`.
- The detected regime agrees with the direction (`TREND_UP` or `TREND_DOWN`).
- The model probability exceeds the executable best ask by at least 10%.

Trades are recorded in:

```text
logs/paper_trades.csv
```

An aggregate summary is maintained separately in:

```text
logs/paper_summary.json
```

The summary is refreshed on startup, whenever a paper trade is created, and
after each official settlement. It includes total, settled and pending trades,
wins, losses, win rate, settled payout, realized PnL, and pending stake.

The simulated entry uses the order book best ask when available and a default
stake of $10. After the market end time, the assistant polls the Polymarket
Gamma API until the market is officially resolved. It then records the winning
outcome, payout, and PnL in the same CSV file. Keep or restart the assistant to
allow pending trades to be settled.

The `Paper Trade` line on the console shows one of these states:

- `waiting for stable signal`
- `UP confirming 18/30s`
- `UP PENDING @ 42.0c`
- `UP SETTLED (+$13.81)`

Optional environment variables:

- `PAPER_TRADING_ENABLED` (default: `true`)
- `PAPER_TRADE_STRATEGY` (default: `TA_EDGE_V1_1`)
- `PAPER_TRADE_CONFIRMATION_SECONDS` (default: `30`)
- `PAPER_TRADE_MIN_REMAINING_MINUTES` (default: `5`)
- `PAPER_TRADE_MAX_REMAINING_MINUTES` (default: `10`)
- `PAPER_TRADE_MIN_EXECUTION_EDGE` (default: `0.1`)
- `PAPER_TRADE_REQUIRE_TREND_ALIGNMENT` (default: `true`)
- `PAPER_TRADE_STAKE_USD` (default: `10`)
- `PAPER_TRADE_SETTLEMENT_POLL_MS` (default: `30000`)
- `PAPER_TRADE_FILE` (default: `./logs/paper_trades.csv`)
- `PAPER_TRADE_SUMMARY_FILE` (default: `./logs/paper_summary.json`)

Each paper trade also records its strategy, executable market probability,
execution edge, confirmation duration, remaining time, and detected regime for
later analysis. Paper PnL does not include Polymarket fees. This feature never
connects a wallet or places a real order.

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
npm start
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
