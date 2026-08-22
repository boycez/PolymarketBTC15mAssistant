import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const unitPath = new URL("../deploy/systemd/polymarket-btc-assistant.service", import.meta.url);
const environmentPath = new URL("../deploy/systemd/engine.env.example", import.meta.url);

test("systemd unit runs the Engine as a hardened unprivileged service", async () => {
  const unit = await fs.readFile(unitPath, "utf8");

  assert.match(unit, /^User=polymarket-btc-assistant$/m);
  assert.match(unit, /^Group=polymarket-btc-assistant$/m);
  assert.match(unit, /^WorkingDirectory=\/opt\/polymarket-btc-assistant$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/polymarket-btc-assistant\/engine\.env$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/env node \/opt\/polymarket-btc-assistant\/src\/engine\.js$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^KillSignal=SIGTERM$/m);
  assert.match(unit, /^RuntimeDirectory=polymarket-btc-assistant$/m);
  assert.match(unit, /^RuntimeDirectoryMode=0750$/m);
  assert.match(unit, /^UMask=0077$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ReadWritePaths=\/opt\/polymarket-btc-assistant\/logs \/run\/polymarket-btc-assistant$/m);
  assert.match(unit, /^SyslogIdentifier=polymarket-btc-assistant$/m);
  assert.doesNotMatch(unit, /npm run|--mode=live|tailscale|ssh/i);
});

test("systemd environment example is Paper-only and contains no credentials", async () => {
  const environment = await fs.readFile(environmentPath, "utf8");

  assert.match(environment, /^TRADING_MODE=paper$/m);
  assert.match(environment, /^POLYMARKET_ENGINE_SOCKET=\/run\/polymarket-btc-assistant\/engine\.sock$/m);
  assert.match(environment, /^POLYMARKET_ENGINE_SOCKET_MODE=0660$/m);
  assert.doesNotMatch(environment, /PRIVATE_KEY|RELAYER_API_KEY|SECRET|TOKEN=/i);
});