import assert from "node:assert/strict";
import test from "node:test";

import { engineInvocation, foregroundInvocation, parsePolyCommand } from "../src/cli/commands.js";

test("parses the public poly command surface", () => {
  assert.deepEqual(parsePolyCommand([]), { command: "help" });
  assert.deepEqual(parsePolyCommand(["start"]), { command: "start", mode: "paper" });
  assert.deepEqual(parsePolyCommand(["start", "live"]), { command: "start", mode: "live" });
  assert.deepEqual(parsePolyCommand(["engine", "restart"]), { command: "engine", action: "restart" });
  assert.deepEqual(parsePolyCommand(["dashboard"]), { command: "dashboard" });
  assert.deepEqual(parsePolyCommand(["doctor"]), { command: "doctor" });
  assert.deepEqual(parsePolyCommand(["install"]), { command: "install" });
  assert.deepEqual(parsePolyCommand(["version"]), { command: "version" });
});

test("rejects unknown commands, actions, modes, and extra arguments", () => {
  assert.throws(() => parsePolyCommand(["gateway", "start"]), /Unknown command/);
  assert.throws(() => parsePolyCommand(["engine", "enable"]), /Invalid engine action/);
  assert.throws(() => parsePolyCommand(["start", "production"]), /Invalid trading mode/);
  assert.throws(() => parsePolyCommand(["dashboard", "extra"]), /does not accept/);
});

test("maps foreground and systemd commands without shell strings", () => {
  assert.deepEqual(foregroundInvocation("live", {
    nodeExecutable: "/usr/bin/node",
    repositoryRoot: "/opt/polymarket-btc15m"
  }), {
    command: "/usr/bin/node",
    args: ["/opt/polymarket-btc15m/src/index.js", "--mode=live"],
    privileged: false
  });
  assert.deepEqual(engineInvocation("restart"), {
    command: "systemctl",
    args: ["restart", "polymarket-engine.service"],
    privileged: true
  });
  assert.deepEqual(engineInvocation("logs"), {
    command: "journalctl",
    args: ["-u", "polymarket-engine.service", "-f"],
    privileged: true
  });
});