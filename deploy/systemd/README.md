# systemd deployment

This deployment runs the Paper Engine continuously on an existing Azure Linux VM. It does not configure SSH, Tailscale, a public port, or Live credentials.

## Prerequisites

- Node.js 24 or newer installed system-wide.
- The repository deployed at `/opt/polymarket-btc-assistant`.
- Dependencies installed with `npm ci --omit=dev`.
- Root access for the one-time service installation.

Confirm Node before installing the service:

```bash
node --version
```

## Install

Deploy the repository, install production dependencies, and register `poly`
with the system Node.js installation:

```bash
cd /opt/polymarket-btc-assistant
sudo npm ci --omit=dev
sudo npm link
sudo poly install
```

`poly install` is Linux/root-only and requires the repository to be exactly at
`/opt/polymarket-btc-assistant`. It:

- creates the non-login `polymarket-btc-assistant` service account when needed;
- keeps application files root-owned and only `logs/` service-writable;
- installs the Paper-only environment and hardened unit;
- verifies the unit with `systemd-analyze verify`;
- enables and starts the Engine;
- adds the invoking `SUDO_USER` to the trusted `polymarket` group.

The environment file is created only when absent, so reinstalling does not
overwrite local settings. Sign out and back in after the first installation so
the new group membership applies. Then attach without running the Dashboard as
the service account:

```bash
poly dashboard
```

The unit creates `/run/polymarket-btc-assistant` with mode `0750` on every boot. Its
Unix socket is `/run/polymarket-btc-assistant/engine.sock` with mode `0660`; only the
service owner and trusted group can access it. No TCP listener is opened.

## Operate

```bash
poly engine status
poly engine restart
poly engine stop
poly engine start
poly engine logs
poly doctor
```

`SIGTERM` stops the health monitor, closes all market streams, runs the Live kill switch when applicable, closes the Unix socket, and then exits. A crash is restarted after five seconds. A normal operator stop is not restarted.

## Update

Stop the Engine before replacing files or dependencies:

```bash
poly engine stop
cd /opt/polymarket-btc-assistant
sudo git pull --ff-only
sudo npm ci --omit=dev
sudo poly install
```

Check status and recent logs after every update:

```bash
poly engine status
poly engine logs
```

For low-level troubleshooting, the CLI maps these operations to
`systemctl polymarket-btc-assistant.service` and
`journalctl -u polymarket-btc-assistant.service -f` without constructing shell command
strings.

## Live safety boundary

Do not change `TRADING_MODE=paper` to `live` in this template. The current Live credential flow intentionally requires hidden interactive terminal input, which systemd cannot provide. Live unattended operation requires Azure Key Vault with Managed Identity and a separate deployment review. Regardless of deployment mode, Engine restart never persists the Armed state.
