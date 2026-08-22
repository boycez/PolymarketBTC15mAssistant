# systemd deployment

This deployment runs the Paper Engine continuously on an existing Azure Linux VM. It does not configure SSH, Tailscale, a public port, or Live credentials.

## Prerequisites

- Node.js 24 or newer installed system-wide.
- The repository deployed at `/opt/polymarket-btc15m`.
- Dependencies installed with `npm ci --omit=dev`.
- Root access for the one-time service installation.

Confirm Node before installing the service:

```bash
node --version
```

## Install

Create a dedicated non-login service account and writable runtime data folder:

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin polymarket
sudo install -d -o root -g polymarket -m 0750 /opt/polymarket-btc15m
sudo install -d -o polymarket -g polymarket -m 0700 /opt/polymarket-btc15m/logs
sudo install -d -o root -g polymarket -m 0750 /etc/polymarket-btc15m
```

After deploying the repository and running `npm ci --omit=dev`, keep application files owned by root and make only `logs/` writable by the service account:

```bash
sudo chown -R root:polymarket /opt/polymarket-btc15m
sudo chown polymarket:polymarket /opt/polymarket-btc15m/logs
sudo chmod 0700 /opt/polymarket-btc15m/logs
```

Install the Paper environment file and service unit:

```bash
sudo install -m 0600 deploy/systemd/engine.env.example /etc/polymarket-btc15m/engine.env
sudo install -m 0644 deploy/systemd/polymarket-engine.service /etc/systemd/system/polymarket-engine.service
sudo systemctl daemon-reload
sudo systemctl enable --now polymarket-engine.service
```

The unit creates `/run/polymarket-btc15m` with mode `0700` on every boot. Its Unix socket is `/run/polymarket-btc15m/engine.sock`; no TCP listener is opened.

## Operate

```bash
sudo systemctl status polymarket-engine.service
sudo systemctl restart polymarket-engine.service
sudo systemctl stop polymarket-engine.service
sudo journalctl -u polymarket-engine.service -f
```

`SIGTERM` stops the health monitor, closes all market streams, runs the Live kill switch when applicable, closes the Unix socket, and then exits. A crash is restarted after five seconds. A normal operator stop is not restarted.

## Update

Stop the Engine before replacing files or dependencies:

```bash
sudo systemctl stop polymarket-engine.service
cd /opt/polymarket-btc15m
sudo git pull --ff-only
sudo npm ci --omit=dev
sudo chown -R root:polymarket /opt/polymarket-btc15m
sudo chown polymarket:polymarket /opt/polymarket-btc15m/logs
sudo systemctl start polymarket-engine.service
```

Check status and recent logs after every update:

```bash
sudo systemctl status polymarket-engine.service
sudo journalctl -u polymarket-engine.service -n 100 --no-pager
```

## Live safety boundary

Do not change `TRADING_MODE=paper` to `live` in this template. The current Live credential flow intentionally requires hidden interactive terminal input, which systemd cannot provide. Live unattended operation requires Azure Key Vault with Managed Identity and a separate deployment review. Regardless of deployment mode, Engine restart never persists the Armed state.
